#!/usr/bin/env node
/**
 * generate-report.js
 *
 * Reads a JSONL log file (captured by tracecc proxy) and generates
 * a self-contained HTML report with:
 *   - Conversations tab: grouped by (model_class, first_user_text), shown as turns
 *   - Raw Calls tab: every API call with cache hit rate, tokens, latency
 *
 * Usage: node generate-report.js <input.jsonl> [output.html]
 */

import fs from 'fs';
import path from 'path';
import { detectFormat, convertCCEntries } from './analyze-lib.js';

// ── Constants ───────────────────────────────────────────────────────────────

const TEXT_PREVIEW_LEN = 200;     // max chars for user text previews
const TOOL_RESULT_MAX = 1000;     // max chars for tool result content display
const TOOL_RESULT_SHORT = 500;    // max chars for tool results in step view
const SYSTEM_PROMPT_MAX = 3000;   // max chars before truncating system prompt
const DESCRIPTION_MAX = 120;      // max chars for tool description preview
const SYSTEM_PROMPT_THRESHOLD = 10000; // system prompt length heuristic for main thread detection

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractSSEData(bodyRaw) {
  if (!bodyRaw) return { usage: null, model: null, text: '', thinking: '' };
  let usage = null, model = null, text = '', thinking = '';
  let finalOutputTokens = 0;

  for (const line of bodyRaw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const evt = JSON.parse(line.slice(5).trim());
      if (evt.type === 'message_start' && evt.message) {
        usage = evt.message.usage || null;
        model = evt.message.model || null;
      }
      if (evt.type === 'message_delta' && evt.usage) {
        finalOutputTokens = evt.usage.output_tokens || 0;
      }
      if (evt.type === 'content_block_delta') {
        const delta = evt.delta || {};
        if (delta.type === 'text_delta') text += delta.text || '';
        if (delta.type === 'thinking_delta') thinking += delta.thinking || '';
      }
    } catch (e) { /* malformed SSE event, skip */ }
  }
  if (usage) usage.output_tokens = finalOutputTokens || usage.output_tokens || 0;
  return { usage, model, text, thinking };
}

function stripSystemReminders(text) {
  if (!text) return '';
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

function getFirstUserText(messages) {
  if (!messages || !messages.length) return '';
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const content = m.content;
    if (typeof content === 'string') return stripSystemReminders(content).slice(0, TEXT_PREVIEW_LEN);
    if (Array.isArray(content)) {
      const texts = content
        .filter(p => p.type === 'text' && typeof p.text === 'string')
        .map(p => stripSystemReminders(p.text))
        .filter(t => t.length > 0);
      return texts.join(' ').slice(0, TEXT_PREVIEW_LEN);
    }
  }
  return '';
}

function getModelClass(model) {
  if (!model) return 'unknown';
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return model;
}

function getSystemPromptLength(system) {
  if (!system) return 0;
  if (typeof system === 'string') return system.length;
  if (Array.isArray(system)) return system.reduce((s, p) => s + (p.text || '').length, 0);
  return 0;
}

// ── Parse JSONL ──────────────────────────────────────────────────────────────

function parseJSONL(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { parsed.push(JSON.parse(line)); } catch {}
  }

  // Detect format and convert if needed
  const format = detectFormat(parsed);
  if (format === 'claude-code') {
    return convertCCEntries(parsed);
  }
  return parsed;
}

// ── Build structured data ────────────────────────────────────────────────────

function extractFromCCContent(content, usage, model) {
  let text = '', thinking = '';
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') text += (block.text || '') + '\n';
      if (block.type === 'thinking') thinking += (block.thinking || '') + '\n';
    }
  }
  return { usage: usage || null, model: model || null, text: text.trim(), thinking: thinking.trim() };
}

function buildRawCalls(entries) {
  return entries.map((e, index) => {
    const reqBody = e.request?.body || {};
    const sse = e._ccContent
      ? extractFromCCContent(e._ccContent, e._ccUsage, e._ccModel)
      : extractSSEData(e.response?.body_raw);
    const usage = sse.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const totalInput = inputTokens + cacheCreation + cacheRead;
    const cacheHitRate = totalInput > 0 ? ((cacheRead / totalInput) * 100) : 0;

    // Extract request-side info
    const messages = reqBody.messages || [];
    const lastUserText = getFirstUserText(messages.slice().reverse().filter(m => m.role === 'user').length ? [messages.slice().reverse().find(m => m.role === 'user')] : []);
    const firstUserText = getFirstUserText(messages);

    // Extract tool_use calls from assistant messages in request
    const requestToolCalls = [];
    for (const msg of messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool_use') {
            requestToolCalls.push({
              name: part.name,
              summary: toolCallSummary(part.name, part.input || {}),
              category: categorizeToolCall(part.name),
            });
          }
        }
      }
    }

    // Build message structure summary: [user, assistant(3 tools), user(3 results), ...]
    const msgStructure = messages.map(m => {
      if (!Array.isArray(m.content)) return m.role;
      const tools = m.content.filter(p => p.type === 'tool_use').length;
      const results = m.content.filter(p => p.type === 'tool_result').length;
      if (tools > 0) return `${m.role}(${tools} tools)`;
      if (results > 0) return `${m.role}(${results} results)`;
      return m.role;
    });

    return {
      index,
      timestamp: e.request?.timestamp,
      loggedAt: e.logged_at,
      method: e.request?.method || '',
      url: e.request?.url || '',
      statusCode: e.response?.status_code,
      model: reqBody.model || sse.model || 'unknown',
      modelClass: getModelClass(reqBody.model || sse.model || ''),
      messageCount: messages.length,
      latency: ((e.response?.timestamp || 0) - (e.request?.timestamp || 0)),
      inputTokens,
      cacheCreation,
      cacheRead,
      outputTokens,
      totalInput,
      cacheHitRate: parseFloat(cacheHitRate.toFixed(1)),
      responseText: sse.text,
      thinkingText: sse.thinking,
      hasTools: Array.isArray(reqBody.tools) && reqBody.tools.length > 0,
      stream: !!reqBody.stream,
      firstUserText,
      lastUserText,
      requestToolCalls,
      msgStructure,
    };
  });
}

/**
 * Extract tool_use and tool_result from a list of new messages (delta since previous step).
 * Returns { newToolCalls, newToolResults }.
 */
function extractStepTools(newMessages) {
  const newToolCalls = [];
  const newToolResults = [];

  for (const msg of newMessages) {
    if (!Array.isArray(msg.content)) continue;
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'tool_use') {
          newToolCalls.push({
            name: part.name,
            summary: toolCallSummary(part.name, part.input || {}),
            category: categorizeToolCall(part.name),
          });
        }
      }
    } else if (msg.role === 'user') {
      for (const part of msg.content) {
        if (part.type === 'tool_result') {
          const rawContent = typeof part.content === 'string'
            ? part.content
            : Array.isArray(part.content)
              ? part.content.map(c => c.text || '').join('\n')
              : '';
          newToolResults.push({
            toolUseId: part.tool_use_id,
            content: rawContent.slice(0, TOOL_RESULT_SHORT),
            isError: !!part.is_error,
          });
        }
      }
    }
  }

  return { newToolCalls, newToolResults };
}

/** Build a step object for each API call in a conversation group. */
function buildSteps(members) {
  return members.map((member, stepIdx) => {
    const stepBody = member.entry.request?.body || {};
    const stepMsgs = stepBody.messages || [];
    const stepSSE = member.entry._ccContent
      ? extractFromCCContent(member.entry._ccContent, member.entry._ccUsage, member.entry._ccModel)
      : extractSSEData(member.entry.response?.body_raw);
    const stepUsage = stepSSE.usage || {};

    const prevMsgCount = stepIdx > 0 ? members[stepIdx - 1].messageCount : 0;
    const newMessages = stepMsgs.slice(prevMsgCount);
    const { newToolCalls, newToolResults } = extractStepTools(newMessages);

    const inputTokens = stepUsage.input_tokens || 0;
    const cacheCreation = stepUsage.cache_creation_input_tokens || 0;
    const cacheRead = stepUsage.cache_read_input_tokens || 0;
    const outputTokens = stepUsage.output_tokens || 0;
    const totalInput = inputTokens + cacheCreation + cacheRead;
    const stepModel = stepSSE.model || stepBody.model || member.model || 'unknown';

    return {
      stepIndex: stepIdx,
      entryIndex: member.entryIndex,
      timestamp: member.entry.request?.timestamp,
      responseTimestamp: member.entry.response?.timestamp,
      latency: (member.entry.response?.timestamp || 0) - (member.entry.request?.timestamp || 0),
      model: stepModel,
      modelClass: getModelClass(stepModel),
      messageCount: stepMsgs.length,
      prevMessageCount: prevMsgCount,
      responseText: stepSSE.text,
      thinkingText: stepSSE.thinking,
      newToolCalls,
      newToolResults,
      totalInput, inputTokens, cacheCreation, cacheRead, outputTokens,
      cacheHitRate: totalInput > 0 ? parseFloat(((cacheRead / totalInput) * 100).toFixed(1)) : 0,
      _ccUuid: member.entry._ccUuid || null,
      _ccParentUuid: member.entry._ccParentUuid || null,
    };
  });
}

/**
 * Split turns into segments at each real user input boundary, and assign
 * steps to the correct segment based on message-index ranges.
 * Returns { segments, stepsBySegment }.
 */
function splitTurnsIntoSegments(allTurns, messages, steps) {
  // Split turns at each new user text input
  const segments = [];
  let currentSegment = [];
  for (const turn of allTurns) {
    if (turn.type === 'user' && turn.content.text && currentSegment.length > 0) {
      segments.push(currentSegment);
      currentSegment = [turn];
    } else {
      currentSegment.push(turn);
    }
  }
  if (currentSegment.length > 0) segments.push(currentSegment);

  // Build user-input boundary indices from messages to map steps → segments
  const userInputMsgIndices = [0];
  let realUserCount = 0;
  for (let mi = 0; mi < messages.length; mi++) {
    if (messages[mi].role === 'user') {
      const txt = extractContent(messages[mi].content);
      if (txt.text) {
        realUserCount++;
        if (realUserCount > 1) userInputMsgIndices.push(mi);
      }
    }
  }

  // Assign each step to the correct segment
  const stepsBySegment = segments.map(() => []);
  for (const step of steps) {
    let segIdx = 0;
    for (let s = userInputMsgIndices.length - 1; s >= 0; s--) {
      if (step.prevMessageCount >= userInputMsgIndices[s] || step.messageCount > userInputMsgIndices[s]) {
        segIdx = s;
        break;
      }
    }
    if (segIdx < stepsBySegment.length) stepsBySegment[segIdx].push(step);
  }

  return { segments, stepsBySegment };
}

/** Link Agent tool_use calls in main threads to matching sub-agent conversations. */
function linkSubAgents(conversations) {
  const mainThreads = conversations.filter(c => c.isMainThread);
  const subAgents = conversations.filter(c => !c.isMainThread);

  for (const main of mainThreads) {
    for (const turn of main.turns) {
      for (const tool of turn.toolCalls) {
        if (tool.name !== 'Agent') continue;
        const agentPrompt = tool.input?.prompt || '';
        const prompt = stripSystemReminders(agentPrompt).slice(0, TEXT_PREVIEW_LEN);
        const match = subAgents.find(sa =>
          sa.firstUserText && prompt && sa.firstUserText.startsWith(prompt.slice(0, 60))
        );
        if (match) {
          tool.linkedConversationId = match.id;
          match.parentConversationId = main.id;
          if (!main.subAgents.find(s => s.id === match.id)) {
            main.subAgents.push(match);
          }
        }
      }
    }
  }
}

/**
 * Build structured conversation objects from parsed log entries.
 *
 * Groups API calls by (modelClass, firstUserText), then splits each group
 * into per-user-input segments. Each segment becomes one conversation card
 * in the UI. Also links main threads to sub-agent conversations.
 */
function buildConversations(entries) {
  // Step 1: Group entries by (modelClass, firstUserText)
  const groups = new Map();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const reqBody = e.request?.body || {};
    const messages = reqBody.messages || [];
    const model = reqBody.model || '';
    if (!messages.length || !model) continue;

    const modelClass = getModelClass(model);
    const firstUserText = getFirstUserText(messages);
    if (!firstUserText) continue;

    const key = `${modelClass}::${firstUserText}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ entryIndex: i, entry: e, messageCount: messages.length, model });
  }

  // Step 2: Build conversations from each group
  const conversations = [];
  for (const [key, members] of groups) {
    members.sort((a, b) => a.messageCount - b.messageCount);
    const final = members[members.length - 1];
    const first = members[0];
    const reqBody = final.entry.request?.body || {};
    const messages = reqBody.messages || [];
    const sseData = final.entry._ccContent
      ? extractFromCCContent(final.entry._ccContent, final.entry._ccUsage, final.entry._ccModel)
      : extractSSEData(final.entry.response?.body_raw);

    const allTurns = extractTurns(messages, sseData);
    const steps = buildSteps(members);

    // Detect main thread vs sub-agent (prefer CC metadata over heuristic)
    const sysLen = getSystemPromptLength(reqBody.system);
    const modelClass = getModelClass(final.model);
    const hasSidechainMeta = members.some(m => m.entry._ccIsSidechain !== undefined);
    const isMainThread = hasSidechainMeta
      ? !final.entry._ccIsSidechain
      : (modelClass === 'opus' || sysLen > SYSTEM_PROMPT_THRESHOLD);

    // Extract system prompt
    const systemRaw = reqBody.system;
    let systemPromptText = '';
    if (typeof systemRaw === 'string') systemPromptText = systemRaw;
    else if (Array.isArray(systemRaw)) systemPromptText = systemRaw.map(p => p.text || '').join('\n\n');

    const toolDefs = (reqBody.tools || []).map(t => ({
      name: t.name || '',
      description: (t.description || '').slice(0, DESCRIPTION_MAX),
    }));

    const truncatedSystemPrompt = systemPromptText.length > SYSTEM_PROMPT_MAX
      ? systemPromptText.slice(0, SYSTEM_PROMPT_MAX) + `\n\n... [truncated, ${systemPromptText.length} chars total]`
      : systemPromptText;

    // Step 3: Split into per-user-input segments
    const { segments, stepsBySegment } = splitTurnsIntoSegments(allTurns, messages, steps);

    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segTurns = segments[segIdx];
      const segUserTurn = segTurns.find(t => t.type === 'user' && t.content.text);
      const segUserText = segUserTurn ? segUserTurn.content.text.slice(0, TEXT_PREVIEW_LEN) : getFirstUserText(messages);
      const segSteps = stepsBySegment[segIdx] || [];

      conversations.push({
        id: `${key}::seg${segIdx}`,
        modelClass,
        model: final.model,
        firstUserText: segUserText,
        isMainThread,
        totalRounds: segSteps.length,
        entryIndices: segSteps.map(s => s.entryIndex),
        startTime: segSteps.length > 0 ? segSteps[0].timestamp : (segIdx === 0 ? first.entry.request?.timestamp : undefined),
        endTime: segSteps.length > 0 ? segSteps[segSteps.length - 1].responseTimestamp : (segIdx === segments.length - 1 ? final.entry.response?.timestamp : undefined),
        turns: segTurns,
        steps: segSteps,
        finalResponseText: segIdx === segments.length - 1 ? sseData.text : '',
        finalThinking: segIdx === segments.length - 1 ? sseData.thinking : '',
        subAgents: [],
        systemPrompt: segIdx === 0 ? truncatedSystemPrompt : '',
        toolDefs: segIdx === 0 ? toolDefs : [],
        _segmentIndex: segIdx,
        _groupKey: key,
      });
    }
  }

  // Step 4: Link sub-agents to main threads and sort
  linkSubAgents(conversations);

  conversations.sort((a, b) => {
    if (a.isMainThread && !b.isMainThread) return -1;
    if (!a.isMainThread && b.isMainThread) return 1;
    return (a.startTime || 0) - (b.startTime || 0);
  });

  return conversations;
}

function extractTurns(messages, finalSSE) {
  const turns = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'user') {
      // User turn
      const userContent = extractContent(msg.content);
      turns.push({
        type: 'user',
        content: userContent,
        toolResults: [],
        toolCalls: [],
      });
      i++;
    } else if (msg.role === 'assistant') {
      // Assistant turn: extract text + tool_use
      const assistantContent = extractContent(msg.content);
      const toolCalls = extractToolCalls(msg.content);
      const toolResults = [];

      // Check if next message is user with tool_results
      if (i + 1 < messages.length && messages[i + 1].role === 'user') {
        const nextContent = messages[i + 1].content;
        if (Array.isArray(nextContent)) {
          for (const part of nextContent) {
            if (part.type === 'tool_result') {
              const rawContent = typeof part.content === 'string'
                ? part.content
                : Array.isArray(part.content)
                  ? part.content.map(c => c.text || '').join('\n')
                  : '';
              toolResults.push({
                toolUseId: part.tool_use_id,
                content: rawContent.length > 1000
                  ? rawContent.slice(0, TOOL_RESULT_MAX) + `\n... [${rawContent.length} chars total]`
                  : rawContent,
                isError: !!part.is_error,
              });
            }
          }
        }
        if (toolResults.length > 0) i++; // skip the tool_result user message
      }

      turns.push({
        type: 'assistant',
        content: assistantContent,
        toolCalls,
        toolResults,
      });
      i++;
    } else {
      i++;
    }
  }

  // If we have SSE text, update or append the final assistant turn
  if (finalSSE.text && turns.length > 0) {
    const lastAssistant = turns.filter(t => t.type === 'assistant').pop();
    if (lastAssistant && !lastAssistant.content.text) {
      // Update existing assistant turn that has no text yet
      lastAssistant.content.text = finalSSE.text;
      lastAssistant.content.thinking = finalSSE.thinking;
    } else if (!lastAssistant) {
      // No assistant turn exists at all — add one
      turns.push({
        type: 'assistant',
        content: { text: finalSSE.text, thinking: finalSSE.thinking },
        toolCalls: [],
        toolResults: [],
      });
    }
  }

  return turns;
}

function extractContent(content) {
  if (typeof content === 'string') {
    return { text: stripSystemReminders(content), thinking: '' };
  }
  if (Array.isArray(content)) {
    let text = '', thinking = '';
    for (const part of content) {
      if (part.type === 'text') text += stripSystemReminders(part.text || '') + '\n';
      if (part.type === 'thinking') thinking += (part.thinking || '') + '\n';
    }
    return { text: text.trim(), thinking: thinking.trim() };
  }
  return { text: '', thinking: '' };
}

function extractToolCalls(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(p => p.type === 'tool_use')
    .map(p => ({
      id: p.id,
      name: p.name,
      input: p.input || {},
      category: categorizeToolCall(p.name),
    }));
}

function toolCallSummary(name, input) {
  switch (name) {
    case 'Read': return input.file_path ? input.file_path.split('/').slice(-2).join('/') : '';
    case 'Grep': return input.pattern ? `"${input.pattern}"` : '';
    case 'Glob': return input.pattern || '';
    case 'Bash': return (input.command || '').slice(0, 80);
    case 'Edit': return input.file_path ? input.file_path.split('/').slice(-2).join('/') : '';
    case 'Write': return input.file_path ? input.file_path.split('/').slice(-2).join('/') : '';
    case 'Agent': return input.description || (input.prompt || '').slice(0, 60);
    default: return '';
  }
}

function categorizeToolCall(name) {
  if (['Read', 'Grep', 'Glob'].includes(name)) return 'file-read';
  if (['Edit', 'Write', 'NotebookEdit'].includes(name)) return 'file-write';
  if (name === 'Bash') return 'command';
  if (name === 'Agent') return 'agent';
  if (['WebFetch', 'WebSearch'].includes(name)) return 'web';
  if (['AskUserQuestion'].includes(name)) return 'interaction';
  return 'other';
}

// ── Generate HTML ────────────────────────────────────────────────────────────

function truncateDeep(obj, maxStrLen = 500, depth = 0) {
  if (depth > 10) return '[nested]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return obj.length > maxStrLen ? obj.slice(0, maxStrLen) + `... [${obj.length} chars total]` : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => truncateDeep(item, maxStrLen, depth + 1));
  }
  if (typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = truncateDeep(v, maxStrLen, depth + 1);
    }
    return result;
  }
  return obj;
}

function buildRawEntries(entries) {
  return entries.map((e, index) => {
    const req = truncateDeep(e.request, 500);
    const resp = { ...e.response };
    // Remove body_raw (SSE stream data, very large)
    if (resp.body_raw) {
      resp._body_raw_length = resp.body_raw.length;
      delete resp.body_raw;
    }
    const respTrunc = truncateDeep(resp, 500);
    return { index, request: req, response: respTrunc, logged_at: e.logged_at };
  });
}

function generateHTML(rawCalls, conversations, rawEntries, inputFile) {
  const data = { rawCalls, conversations, rawEntries, inputFile, generatedAt: new Date().toISOString() };
  const dataJSON = JSON.stringify(data);
  const encodedData = Buffer.from(dataJSON).toString('base64');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Session Report — ${path.basename(inputFile)}</title>
<style>
${getCSS()}
</style>
</head>
<body>
<div id="app"></div>
<script>
${getJS()}

// Load data (UTF-8 safe base64 decode)
const bytes = Uint8Array.from(atob('${encodedData}'), c => c.charCodeAt(0));
const raw = new TextDecoder().decode(bytes);
const data = JSON.parse(raw);
renderApp(data);
</script>
</body>
</html>`;
}

function getCSS() {
  return `
:root {
  --bg: #1e1e1e;
  --bg-card: #252526;
  --bg-hover: #2d2d30;
  --bg-active: #37373d;
  --border: #3e3e42;
  --text: #cccccc;
  --text-muted: #808080;
  --text-bright: #e0e0e0;
  --accent: #569cd6;
  --accent2: #4ec9b0;
  --green: #6a9955;
  --orange: #ce9178;
  --red: #f44747;
  --yellow: #dcdcaa;
  --purple: #c586c0;
  --blue: #9cdcfe;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.6;
}

.container { max-width: 960px; margin: 0 auto; padding: 16px; }

/* Header */
.header {
  border-bottom: 1px solid var(--border);
  padding-bottom: 12px;
  margin-bottom: 16px;
}
.header h1 { color: var(--accent); font-size: 16px; font-weight: 600; }
.header .meta { color: var(--text-muted); font-size: 12px; margin-top: 4px; }
.header .meta span { margin-right: 16px; }

/* Tabs */
.tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}
.tab {
  padding: 8px 20px;
  cursor: pointer;
  color: var(--text-muted);
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
  user-select: none;
}
.tab:hover { color: var(--text); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }

.tab-content { display: none; }
.tab-content.active { display: block; }

/* Conversations */
.conversation {
  border: 1px solid var(--border);
  margin-bottom: 12px;
}
.conv-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  background: var(--bg-card);
  cursor: pointer;
  user-select: none;
}
.conv-header:hover { background: var(--bg-hover); }
.conv-header .title { color: var(--accent2); font-weight: 600; }
.conv-header .badge {
  display: inline-block;
  padding: 1px 6px;
  font-size: 11px;
  border-radius: 3px;
  margin-left: 8px;
}
.badge-opus { background: rgba(86,156,214,0.2); color: var(--accent); }
.badge-haiku { background: rgba(78,201,176,0.2); color: var(--accent2); }
.badge-sonnet { background: rgba(197,134,192,0.2); color: var(--purple); }
.conv-meta { color: var(--text-muted); font-size: 11px; }
.conv-body { display: none; padding: 0; }
.conv-body.open { display: block; }

/* Turns */
.turn {
  border-top: 1px solid var(--border);
  padding: 12px 14px;
}
.turn-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  margin-bottom: 6px;
}
.turn-label.user { color: var(--green); }
.turn-label.assistant { color: var(--accent); }

.turn-text {
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-bright);
}
.turn-text.muted { color: var(--text-muted); }

/* Tool calls */
.tool-call {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 0;
  color: var(--text);
}
.tool-icon {
  flex-shrink: 0;
  width: 18px;
  text-align: center;
  color: var(--text-muted);
}
.tool-name { color: var(--yellow); font-weight: 600; }
.tool-desc { color: var(--text-muted); margin-left: 4px; }
.tool-category-file-read .tool-name { color: var(--blue); }
.tool-category-file-write .tool-name { color: var(--orange); }
.tool-category-command .tool-name { color: var(--accent2); }
.tool-category-agent .tool-name { color: var(--purple); }

/* Collapsible */
.collapsible-toggle {
  cursor: pointer;
  color: var(--text-muted);
  font-size: 12px;
  user-select: none;
  padding: 4px 0;
}
.collapsible-toggle:hover { color: var(--text); }
.collapsible-content { display: none; }
.collapsible-content.open { display: block; }

/* Tool result */
.tool-result {
  margin: 4px 0 4px 26px;
  padding: 6px 10px;
  background: var(--bg);
  border-left: 2px solid var(--border);
  font-size: 12px;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-muted);
}
.tool-result.error { border-left-color: var(--red); color: var(--red); }

/* Thinking */
.thinking-block {
  margin: 4px 0;
  padding: 6px 10px;
  background: rgba(86,156,214,0.05);
  border-left: 2px solid var(--accent);
  font-size: 12px;
  max-height: 150px;
  overflow-y: auto;
  white-space: pre-wrap;
  color: var(--text-muted);
  font-style: italic;
}

/* Sub-agent link */
.agent-link {
  color: var(--purple);
  cursor: pointer;
  text-decoration: underline;
}
.agent-link:hover { color: var(--text-bright); }

/* Raw calls table */
.raw-table { width: 100%; border-collapse: collapse; }
.raw-table th {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 2px solid var(--border);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  position: sticky;
  top: 0;
  background: var(--bg);
}
.raw-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  vertical-align: top;
}
.raw-table tr { cursor: pointer; }
.raw-table tr:hover td { background: var(--bg-hover); }
.raw-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.cache-high { color: var(--green); font-weight: 600; }
.cache-mid { color: var(--yellow); }
.cache-low { color: var(--red); }

.raw-detail {
  display: none;
  padding: 10px 14px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
}
.raw-detail.open { display: table-row; }
.raw-detail td { padding: 10px 14px; }

/* Markdown-like rendering */
.md-content h1, .md-content h2, .md-content h3 { color: var(--accent); margin: 12px 0 6px; }
.md-content h1 { font-size: 16px; }
.md-content h2 { font-size: 14px; }
.md-content h3 { font-size: 13px; }
.md-content code {
  background: var(--bg);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}
.md-content pre {
  background: var(--bg);
  padding: 10px;
  border-radius: 4px;
  overflow-x: auto;
  margin: 8px 0;
}
.md-content pre code { padding: 0; background: none; }
.md-content ul, .md-content ol { padding-left: 20px; margin: 4px 0; }
.md-content li { margin: 2px 0; }
.md-content table { border-collapse: collapse; margin: 8px 0; }
.md-content th, .md-content td {
  border: 1px solid var(--border);
  padding: 4px 8px;
  font-size: 12px;
}
.md-content th { background: var(--bg-hover); color: var(--accent); }
.md-content strong { color: var(--text-bright); }
.md-content hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
.md-content blockquote {
  border-left: 3px solid var(--accent);
  padding-left: 12px;
  color: var(--text-muted);
  margin: 8px 0;
}

/* Simulator */
.sim-controls {
  display: flex; align-items: center; gap: 10px; padding: 10px 0;
  border-bottom: 1px solid var(--border); margin-bottom: 12px; flex-wrap: wrap;
}
.sim-btn {
  padding: 5px 14px; background: var(--bg-card); border: 1px solid var(--border);
  color: var(--text); cursor: pointer; font-family: inherit; font-size: 12px;
}
.sim-btn:hover { background: var(--bg-hover); border-color: var(--accent); }
.sim-btn:disabled { opacity: 0.3; cursor: default; }
.sim-btn.primary { background: rgba(86,156,214,0.2); border-color: var(--accent); color: var(--accent); }
.sim-btn.playing { background: rgba(244,71,71,0.2); border-color: var(--red); color: var(--red); }
.sim-select {
  padding: 5px 8px; background: var(--bg-card); border: 1px solid var(--border);
  color: var(--text); font-family: inherit; font-size: 12px; max-width: 400px;
}
.sim-step-label { color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }

/* Flowchart */
.flow-canvas {
  position: relative; padding: 16px 0;
}
.flow-svg {
  position: absolute; top: 0; left: 0; width: 100%; height: 100%;
  pointer-events: none; z-index: 0;
}
.flow-svg line { stroke: var(--border); stroke-width: 1.5; }
.flow-svg polygon { fill: var(--text-muted); }
.flow-svg path { stroke: var(--border); stroke-width: 1.5; fill: none; }
.flow-nodes {
  position: relative; z-index: 1;
  display: flex; flex-wrap: wrap; gap: 8px 0; align-items: flex-start;
}
.flow-row {
  display: flex; align-items: center; width: 100%; gap: 0;
  padding: 4px 0;
}
.flow-row.reverse { flex-direction: row-reverse; }

.flow-group {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  flex-shrink: 0;
}
.flow-arrow {
  flex-shrink: 0; width: 32px; display: flex; align-items: center; justify-content: center;
  color: var(--text-muted); font-size: 16px; opacity: 0.15; transition: opacity 0.3s;
}
.flow-arrow.visible { opacity: 0.6; }

.flow-node {
  border: 1px solid var(--border); padding: 6px 10px; font-size: 11px;
  max-width: 200px; min-width: 80px; cursor: pointer;
  opacity: 0.15; transition: all 0.3s; position: relative;
  background: var(--bg-card);
}
.flow-node.visible { opacity: 1; }
.flow-node.current { opacity: 1; box-shadow: 0 0 0 2px var(--accent), 0 0 12px rgba(86,156,214,0.3); }

.flow-node .flow-icon { font-size: 13px; margin-right: 4px; }
.flow-node .flow-label {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block;
}
.flow-node .flow-detail {
  display: none; white-space: pre-wrap; font-size: 10px; color: var(--text-muted);
  margin-top: 4px; max-height: 120px; overflow-y: auto; word-break: break-all;
}
.flow-node.expanded .flow-label { white-space: pre-wrap; }
.flow-node.expanded .flow-detail { display: block; }
.flow-node.expanded { max-width: 400px; }

.flow-node .flow-meta {
  font-size: 10px; color: var(--text-muted); margin-top: 2px;
}

/* Node type styles */
.flow-node.node-request { border-left: 3px solid var(--green); border-radius: 8px; }
.flow-node.node-response { border-left: 3px solid var(--accent); border-radius: 8px; }
.flow-node.node-thinking { border-left: 3px solid var(--purple); border-radius: 12px; font-style: italic; background: rgba(197,134,192,0.05); }
.flow-node.node-tool-call { border-left: 3px solid var(--yellow); }
.flow-node.node-agent-call { border-left: 3px solid var(--purple); border-width: 2px; }
.flow-node.node-tool-result { border-left: 3px solid var(--yellow); border-style: dashed; }
.flow-node.node-agent-result { border-left: 3px solid var(--purple); border-style: dashed; }

/* Context meter */
.ctx-meter {
  display: flex; align-items: center; gap: 8px; padding: 8px 0;
  border-top: 1px solid var(--border); margin-top: 4px; font-size: 11px;
}
.ctx-bar-bg { flex: 1; height: 8px; background: var(--bg-card); border-radius: 4px; overflow: hidden; }
.ctx-bar { height: 100%; background: var(--accent); transition: width 0.3s; border-radius: 4px; }
.ctx-label { color: var(--text-muted); min-width: 120px; text-align: right; font-variant-numeric: tabular-nums; }

/* Legend */
.flow-legend {
  display: flex; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--border);
  margin-bottom: 8px; flex-wrap: wrap;
}
.flow-legend-item {
  display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--text-muted);
}
.flow-legend-swatch {
  width: 12px; height: 12px; border: 1px solid var(--border);
}
.flow-legend-swatch.sw-user { border-left: 3px solid var(--green); border-radius: 4px; }
.flow-legend-swatch.sw-thinking { border-left: 3px solid var(--purple); border-radius: 6px; }
.flow-legend-swatch.sw-tool { border-left: 3px solid var(--yellow); }
.flow-legend-swatch.sw-agent { border-left: 3px solid var(--purple); border-width: 2px; }
.flow-legend-swatch.sw-response { border-left: 3px solid var(--accent); border-radius: 4px; }

/* Sub-agent depth indicators */
.flow-node.depth-1 { border-top: 2px solid var(--purple); }
.flow-node.depth-2 { border-top: 2px solid var(--yellow); }
.flow-node.depth-3 { border-top: 2px solid var(--red); }
.flow-depth-tag {
  position: absolute; top: -8px; right: 4px;
  font-size: 8px; padding: 0 4px; line-height: 14px;
  background: var(--purple); color: var(--bg); border-radius: 2px;
  text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px;
}
`;
}

function getJS() {
  return `
// ── Helpers ──────────────────────────────────────────────────────────────────

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString();
}

function fmtDuration(sec) {
  if (!sec || sec < 0) return '-';
  return sec.toFixed(1) + 's';
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function cacheClass(rate) {
  if (rate >= 80) return 'cache-high';
  if (rate >= 40) return 'cache-mid';
  return 'cache-low';
}

function simpleMarkdown(text) {
  if (!text) return '';
  let html = esc(text);
  // Code blocks
  html = html.replace(/\`\`\`(\\w*)?\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold
  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  // Horizontal rule
  html = html.replace(/^---$/gm, '<hr>');
  // Blockquote
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // Unordered list
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\\/li>\\n?)+)/g, '<ul>$1</ul>');
  // Table (simple)
  html = html.replace(/^\\|(.+)\\|$/gm, (match, content) => {
    const cells = content.split('|').map(c => c.trim());
    if (cells.every(c => /^[-:]+$/.test(c))) return ''; // separator row
    const tag = cells.some(c => /^\\*\\*/.test(c)) ? 'th' : 'td';
    return '<tr>' + cells.map(c => '<' + tag + '>' + c + '</' + tag + '>').join('') + '</tr>';
  });
  html = html.replace(/((?:<tr>.*<\\/tr>\\n?)+)/g, '<table>$1</table>');
  // Line breaks
  html = html.replace(/\\n/g, '<br>');
  // Clean up
  html = html.replace(/<br><h/g, '<h').replace(/<\\/h(\\d)><br>/g, '</h$1>');
  html = html.replace(/<br><pre>/g, '<pre>').replace(/<\\/pre><br>/g, '</pre>');
  html = html.replace(/<br><ul>/g, '<ul>').replace(/<\\/ul><br>/g, '</ul>');
  html = html.replace(/<br><table>/g, '<table>').replace(/<\\/table><br>/g, '</table>');
  html = html.replace(/<br><hr>/g, '<hr>').replace(/<hr><br>/g, '<hr>');
  html = html.replace(/<br><blockquote>/g, '<blockquote>').replace(/<\\/blockquote><br>/g, '</blockquote>');
  return html;
}

function toolIcon(category) {
  const icons = {
    'file-read': '&#128196;',
    'file-write': '&#9998;',
    'command': '&#9654;',
    'agent': '&#129302;',
    'web': '&#127760;',
    'interaction': '&#128172;',
    'other': '&#8226;',
  };
  return icons[category] || icons.other;
}

function toolSummary(tool) {
  const inp = tool.input || {};
  switch (tool.name) {
    case 'Read': return inp.file_path ? inp.file_path.split('/').slice(-2).join('/') : '';
    case 'Grep': return inp.pattern ? '"' + inp.pattern + '"' : '';
    case 'Glob': return inp.pattern || '';
    case 'Bash': return (inp.command || '').slice(0, 80);
    case 'Edit': return inp.file_path ? inp.file_path.split('/').slice(-2).join('/') : '';
    case 'Write': return inp.file_path ? inp.file_path.split('/').slice(-2).join('/') : '';
    case 'Agent': return inp.description || (inp.prompt || '').slice(0, 60);
    default: return '';
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderApp(data) {
  const app = document.getElementById('app');

  // Overview
  const calls = data.rawCalls;
  const convs = data.conversations;
  const firstTs = calls.length ? calls[0].timestamp : null;
  const lastTs = calls.length ? calls[calls.length - 1].timestamp : null;
  const models = [...new Set(calls.map(c => c.model))];
  const totalInput = calls.reduce((s, c) => s + c.totalInput, 0);
  const totalOutput = calls.reduce((s, c) => s + c.outputTokens, 0);

  app.innerHTML = \`
    <div class="container">
      <div class="header">
        <h1>Claude Session Report</h1>
        <div class="meta">
          <span>\${fmtTime(firstTs)} ~ \${fmtTime(lastTs)}</span>
          <span>\${calls.length} API calls</span>
          <span>\${models.join(', ')}</span>
          <span>In: \${fmtTokens(totalInput)} / Out: \${fmtTokens(totalOutput)}</span>
        </div>
      </div>
      <div class="tabs">
        <div class="tab active" data-tab="conversations">Conversations</div>
        <div class="tab" data-tab="rawcalls">Raw Calls</div>
        <div class="tab" data-tab="insight">Raw Call Insight</div>
        <div class="tab" data-tab="simulator">Simulator</div>
      </div>
      <div id="tab-conversations" class="tab-content active">
        \${renderConversations(convs)}
      </div>
      <div id="tab-rawcalls" class="tab-content">
        \${renderRawEntries(data.rawEntries || [])}
      </div>
      <div id="tab-insight" class="tab-content">
        \${renderRawCalls(calls)}
      </div>
      <div id="tab-simulator" class="tab-content">
        \${renderSimulator(convs)}
      </div>
    </div>
  \`;

  // Tab switching
  let simInitialized = false;
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      // Lazy init simulator when first shown
      if (tab.dataset.tab === 'simulator' && !simInitialized) {
        simInitialized = true;
        initSimulator();
      }
    });
  });

  // Collapsible conversations
  document.querySelectorAll('.conv-header').forEach(header => {
    header.addEventListener('click', () => {
      const body = header.nextElementSibling;
      body.classList.toggle('open');
      const arrow = header.querySelector('.arrow');
      if (arrow) arrow.textContent = body.classList.contains('open') ? '[-]' : '[+]';
    });
  });

  // Collapsible tool results & thinking
  document.querySelectorAll('.collapsible-toggle').forEach(toggle => {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const content = toggle.nextElementSibling;
      content.classList.toggle('open');
      const indicator = toggle.querySelector('.indicator');
      if (indicator) indicator.textContent = content.classList.contains('open') ? '[-]' : '[+]';
    });
  });

  // Raw call expand
  document.querySelectorAll('.raw-row').forEach(row => {
    row.addEventListener('click', () => {
      const detail = row.nextElementSibling;
      if (detail && detail.classList.contains('raw-detail')) {
        detail.classList.toggle('open');
      }
    });
  });

  // Agent links
  document.querySelectorAll('.agent-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetId = link.dataset.target;
      const target = document.getElementById(targetId);
      if (target) {
        const body = target.querySelector('.conv-body');
        if (body && !body.classList.contains('open')) {
          body.classList.add('open');
          const arrow = target.querySelector('.arrow');
          if (arrow) arrow.textContent = '[-]';
        }
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

function renderConversations(conversations) {
  // Separate main threads and orphan sub-agents
  const mainThreads = conversations.filter(c => c.isMainThread);
  const linkedSubAgents = new Set();
  mainThreads.forEach(m => m.subAgents.forEach(s => linkedSubAgents.add(s.id)));
  const orphanSubAgents = conversations.filter(c => !c.isMainThread && !linkedSubAgents.has(c.id));

  let html = '';

  // Main threads
  for (const conv of mainThreads) {
    html += renderConversation(conv, true);
  }

  // Orphan sub-agents (not linked to any main thread)
  if (orphanSubAgents.length > 0) {
    html += '<div style="margin-top:16px;color:var(--text-muted);font-size:12px;">Other conversations</div>';
    for (const conv of orphanSubAgents) {
      html += renderConversation(conv, false);
    }
  }

  // Linked sub-agents (shown after their parent)
  for (const main of mainThreads) {
    if (main.subAgents.length > 0) {
      html += '<div style="margin-top:16px;color:var(--text-muted);font-size:12px;">Sub-agents of main thread</div>';
      for (const sub of main.subAgents) {
        html += renderConversation(sub, false);
      }
    }
  }

  return html || '<div style="color:var(--text-muted)">No conversations found</div>';
}

function convIdToHtmlId(id) {
  // Create a safe HTML id from the conversation id
  return 'conv-' + btoa(encodeURIComponent(id)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
}

function renderConversation(conv, isOpen) {
  const htmlId = convIdToHtmlId(conv.id);
  const modelBadge = '<span class="badge badge-' + conv.modelClass + '">' + esc(conv.model) + '</span>';
  const userPreview = esc(conv.firstUserText.slice(0, 80)) + (conv.firstUserText.length > 80 ? '...' : '');

  // System Prompt & Tools header
  let headerHtml = '';
  if (conv.systemPrompt) {
    const sysPreview = esc(conv.systemPrompt.slice(0, 100)) + (conv.systemPrompt.length > 100 ? '...' : '');
    headerHtml += \`
      <div class="turn" style="border-top:none">
        <div class="collapsible-toggle"><span class="indicator">[+]</span> System Prompt (\${conv.systemPrompt.length.toLocaleString()} chars)</div>
        <div class="collapsible-content">
          <div class="tool-result" style="max-height:400px">\${esc(conv.systemPrompt)}</div>
        </div>
      </div>\`;
  }
  if (conv.toolDefs && conv.toolDefs.length > 0) {
    const toolList = conv.toolDefs.map(t =>
      '<div style="padding:2px 0"><span class="tool-name">' + esc(t.name) + '</span> <span class="tool-desc">' + esc(t.description) + '</span></div>'
    ).join('');
    headerHtml += \`
      <div class="turn">
        <div class="collapsible-toggle"><span class="indicator">[+]</span> Tools (\${conv.toolDefs.length})</div>
        <div class="collapsible-content">
          <div style="padding:6px 10px;background:var(--bg);border-left:2px solid var(--border);font-size:12px">\${toolList}</div>
        </div>
      </div>\`;
  }

  let turnsHtml = headerHtml;
  let turnNum = 0;
  for (const turn of conv.turns) {
    turnNum++;
    if (turn.type === 'user') {
      // Skip user turns that are only tool results
      const textContent = turn.content.text;
      if (!textContent && turn.toolResults && turn.toolResults.length > 0) continue;
      if (!textContent) continue;

      turnsHtml += \`
        <div class="turn">
          <div class="turn-label user">Turn \${turnNum} &mdash; User</div>
          <div class="turn-text">\${esc(textContent)}</div>
        </div>\`;
    } else if (turn.type === 'assistant') {
      const hasThinking = turn.content.thinking;
      const hasText = turn.content.text;
      const hasTools = turn.toolCalls && turn.toolCalls.length > 0;

      turnsHtml += '<div class="turn">';
      turnsHtml += '<div class="turn-label assistant">Turn ' + turnNum + ' &mdash; Assistant</div>';

      // Thinking (collapsed)
      if (hasThinking) {
        turnsHtml += \`
          <div class="collapsible-toggle"><span class="indicator">[+]</span> Thinking...</div>
          <div class="collapsible-content">
            <div class="thinking-block">\${esc(turn.content.thinking)}</div>
          </div>\`;
      }

      // Tool calls
      if (hasTools) {
        for (const tool of turn.toolCalls) {
          const summary = esc(toolSummary(tool));
          const isAgent = tool.name === 'Agent';
          const linkedId = tool.linkedConversationId ? convIdToHtmlId(tool.linkedConversationId) : '';

          turnsHtml += '<div class="tool-call tool-category-' + tool.category + '">';
          turnsHtml += '<span class="tool-icon">' + toolIcon(tool.category) + '</span>';
          turnsHtml += '<span class="tool-name">' + esc(tool.name) + '</span>';
          if (summary) turnsHtml += '<span class="tool-desc">' + summary + '</span>';
          if (isAgent && linkedId) {
            turnsHtml += ' <span class="agent-link" data-target="' + linkedId + '">[view]</span>';
          }
          turnsHtml += '</div>';

          // Show tool result if available
          const result = (turn.toolResults || []).find(r => r.toolUseId === tool.id);
          if (result && result.content) {
            const preview = result.content.length > 200 ? result.content.slice(0, 200) + '...' : result.content;
            turnsHtml += \`
              <div class="collapsible-toggle" style="margin-left:26px"><span class="indicator">[+]</span> Result (\${result.content.length} chars)</div>
              <div class="collapsible-content">
                <div class="tool-result \${result.isError ? 'error' : ''}">\${esc(result.content)}</div>
              </div>\`;
          }
        }
      }

      // Text response
      if (hasText) {
        // If this is the last turn, render as markdown
        const isLastTurn = turnNum === conv.turns.length ||
          (turnNum === conv.turns.filter(t => t.type === 'assistant').length + conv.turns.filter(t => t.type === 'user').length);
        if (isLastTurn || (!hasTools && hasText)) {
          turnsHtml += '<div class="md-content" style="margin-top:8px">' + simpleMarkdown(turn.content.text) + '</div>';
        } else if (hasText && hasTools) {
          // Brief text alongside tools
          turnsHtml += '<div class="turn-text muted" style="margin-top:4px">' + esc(turn.content.text.slice(0, 200)) + '</div>';
        }
      }

      turnsHtml += '</div>';
    }
  }

  return \`
    <div class="conversation" id="\${htmlId}">
      <div class="conv-header">
        <div>
          <span class="arrow">\${isOpen ? '[-]' : '[+]'}</span>
          <span class="title">\${userPreview}</span>
          \${modelBadge}
        </div>
        <div class="conv-meta">
          \${conv.turns.length} turns\${conv.totalRounds ? ' &middot; ' + conv.totalRounds + ' rounds' : ''} \${conv.startTime ? '&middot; ' + fmtTime(conv.startTime) : ''}
        </div>
      </div>
      <div class="conv-body \${isOpen ? 'open' : ''}">
        \${turnsHtml}
      </div>
    </div>\`;
}

function renderRawEntries(entries) {
  if (!entries || entries.length === 0) return '<div style="color:var(--text-muted)">No raw entries</div>';

  let html = '';
  for (const e of entries) {
    const req = e.request || {};
    const resp = e.response || {};
    const model = req.body?.model || 'unknown';
    const method = req.method || '';
    const ts = e.logged_at || '';
    const msgCount = Array.isArray(req.body?.messages) ? req.body.messages.length : 0;

    // Format request body for display: show everything except we'll make messages collapsible
    const reqForDisplay = { ...req };
    // Format response for display
    const respForDisplay = { ...resp };

    html += \`
      <div class="conversation" style="margin-bottom:8px">
        <div class="conv-header">
          <div>
            <span class="arrow">[+]</span>
            <span style="color:var(--accent2);font-weight:600">#\${e.index + 1}</span>
            <span style="margin-left:8px">\${esc(method)}</span>
            <span class="badge badge-\${getModelClass(model)}" style="margin-left:8px">\${esc(model)}</span>
            <span style="color:var(--text-muted);margin-left:8px">\${msgCount} msgs</span>
          </div>
          <div class="conv-meta">\${esc(ts)}</div>
        </div>
        <div class="conv-body">
          <div style="display:flex;gap:16px;flex-wrap:wrap;padding:12px 14px">
            <div style="flex:1;min-width:400px">
              <div style="color:var(--green);font-weight:600;font-size:11px;text-transform:uppercase;margin-bottom:6px">Request</div>
              <pre style="background:var(--bg);padding:10px;border-radius:4px;overflow:auto;max-height:600px;font-size:11px;white-space:pre-wrap;word-break:break-all">\${esc(JSON.stringify(reqForDisplay, null, 2))}</pre>
            </div>
            <div style="flex:1;min-width:400px">
              <div style="color:var(--accent);font-weight:600;font-size:11px;text-transform:uppercase;margin-bottom:6px">Response\${resp._body_raw_length ? ' (SSE body_raw: ' + resp._body_raw_length.toLocaleString() + ' chars, omitted)' : ''}</div>
              <pre style="background:var(--bg);padding:10px;border-radius:4px;overflow:auto;max-height:600px;font-size:11px;white-space:pre-wrap;word-break:break-all">\${esc(JSON.stringify(respForDisplay, null, 2))}</pre>
            </div>
          </div>
        </div>
      </div>\`;
  }
  return html;
}

function getModelClass(model) {
  if (!model) return 'unknown';
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return model;
}

// ── Simulator ────────────────────────────────────────────────────────────────

let simState = { conversations: [], currentConvIndex: 0, currentStep: -1, playTimer: null, unifiedMsgs: [] };

function renderSimulator(conversations) {
  // Only show main threads — sub-agents are inlined into the main flow
  const mainConvs = conversations.filter(c => c.isMainThread && c.steps && c.steps.length > 1);
  simState.conversations = mainConvs;

  if (mainConvs.length === 0) {
    return '<div style="color:var(--text-muted);padding:20px">No multi-step conversations to simulate.</div>';
  }

  let options = mainConvs.map((c, i) => {
    const totalSteps = countUnifiedSteps(c);
    const label = c.firstUserText.slice(0, 60) + ' (' + totalSteps + ' steps)';
    return '<option value="' + i + '">' + esc(label) + '</option>';
  }).join('');

  const showSelect = mainConvs.length > 1;

  return \`
    <div id="sim-container">
      <div class="sim-controls">
        \${showSelect ? '<select class="sim-select" id="sim-conv-select">' + options + '</select>' : '<input type="hidden" id="sim-conv-select" value="0">'}
        <button class="sim-btn primary" id="sim-play">&#9654; Play</button>
        <button class="sim-btn" id="sim-step">Step &rarr;</button>
        <button class="sim-btn" id="sim-reset">Reset</button>
        <div class="sim-step-label" id="sim-step-label">Ready</div>
      </div>
      <div id="sim-diagram"></div>
    </div>
  \`;
}

function countUnifiedSteps(conv) {
  let count = conv.steps.length;
  if (conv.subAgents) {
    for (const sub of conv.subAgents) {
      count += sub.steps ? sub.steps.length : 0;
    }
  }
  return count;
}

function initSimulator() {
  const container = document.getElementById('sim-container');
  if (!container) return;

  const select = document.getElementById('sim-conv-select');
  const playBtn = document.getElementById('sim-play');

  function getTotal() {
    return simState.unifiedMsgs.length > 0
      ? Math.max(...simState.unifiedMsgs.map(m => m.stepIndex)) + 1
      : 0;
  }

  function simStep() {
    const total = getTotal();
    if (total === 0) return;
    if (simState.currentStep < total - 1) {
      simState.currentStep++;
      renderDiagram();
    } else {
      simStop();
    }
  }

  function simPlay() {
    if (simState.playTimer) { simStop(); return; }
    const total = getTotal();
    if (simState.currentStep >= total - 1) {
      simState.currentStep = -1;
    }
    playBtn.innerHTML = '&#9646;&#9646; Pause';
    playBtn.classList.add('playing');
    simStep();
    simState.playTimer = setInterval(() => { simStep(); }, 1500);
  }

  function simStop() {
    if (simState.playTimer) { clearInterval(simState.playTimer); simState.playTimer = null; }
    playBtn.innerHTML = '&#9654; Play';
    playBtn.classList.remove('playing');
  }

  playBtn.addEventListener('click', simPlay);
  document.getElementById('sim-step').addEventListener('click', () => { simStop(); simStep(); });
  document.getElementById('sim-reset').addEventListener('click', () => {
    simStop(); simState.currentStep = -1; renderDiagram();
  });
  if (select.tagName === 'SELECT') {
    select.addEventListener('change', () => {
      simStop();
      simState.currentConvIndex = parseInt(select.value);
      simState.currentStep = -1; renderDiagram();
    });
  }

  simState.currentConvIndex = 0;
  simState.currentStep = -1;
  renderDiagram();
}

function getCurrentConv() { return simState.conversations[simState.currentConvIndex]; }

function buildUnifiedMessages(conv) {
  // Build a flat list of messages merging main thread + sub-agents
  // Each message: { from, to, label, detail, type, stepIndex, depth, convLabel }
  // depth: 0 = main, 1 = sub-agent
  const msgs = [];
  let globalStep = 0;

  function addConvMessages(c, depth) {
    const convLabel = depth === 0 ? '' : c.modelClass;

    for (let si = 0; si < c.steps.length; si++) {
      const step = c.steps[si];
      const isFirst = si === 0;
      const curGlobal = globalStep++;

      // Step 0: user/parent sends request
      if (isFirst) {
        msgs.push({
          from: 'user', to: 'llm', type: 'request', stepIndex: curGlobal,
          label: c.firstUserText.slice(0, 80),
          detail: '', depth, convLabel,
          meta: { tokens: step.totalInput, cache: step.cacheHitRate },
        });
      }

      // Tool results from previous step
      if (!isFirst && step.newToolResults.length > 0) {
        const toolNames = c.steps[si - 1]?.newToolCalls?.map(t => t.name) || [];
        const isAgentResult = toolNames.some(n => n === 'Agent');
        msgs.push({
          from: isAgentResult ? 'agents' : 'tools', to: 'llm', type: 'result', stepIndex: curGlobal,
          label: step.newToolResults.length + ' result(s)',
          detail: step.newToolResults.map(r => (r.isError ? '[ERR] ' : '') + (r.content || '').slice(0, 80)).join('\\n'),
          depth, convLabel,
          meta: { tokens: step.totalInput, cache: step.cacheHitRate },
        });
      }

      // Thinking
      if (step.thinkingText) {
        msgs.push({
          from: 'llm', to: 'llm', type: 'thinking', stepIndex: curGlobal,
          label: 'thinking...', detail: step.thinkingText.slice(0, 300),
          depth, convLabel,
        });
      }

      // Tool calls
      if (step.newToolCalls.length > 0) {
        const agentCalls = step.newToolCalls.filter(t => t.category === 'agent');
        const toolCalls = step.newToolCalls.filter(t => t.category !== 'agent');

        if (toolCalls.length > 0) {
          msgs.push({
            from: 'llm', to: 'tools', type: 'call', stepIndex: curGlobal,
            label: toolCalls.map(t => t.name + ': ' + t.summary.slice(0, 40)).join('\\n'),
            detail: '', depth, convLabel,
          });
        }
        if (agentCalls.length > 0) {
          msgs.push({
            from: 'llm', to: 'agents', type: 'call', stepIndex: curGlobal,
            label: agentCalls.map(t => 'Agent: ' + t.summary.slice(0, 50)).join('\\n'),
            detail: '', depth, convLabel,
          });
          // Inline sub-agent steps right after the agent call
          for (const ac of agentCalls) {
            const subName = (ac.summary || ac.name || '').slice(0, 60);
            const matchedSub = (conv.subAgents || []).find(sa =>
              sa.firstUserText && subName && sa.firstUserText.startsWith(subName.slice(0, 30))
            );
            if (matchedSub) {
              addConvMessages(matchedSub, depth + 1);
            }
          }
        }
      }

      // Response text
      if (step.responseText && step.newToolCalls.length === 0) {
        msgs.push({
          from: 'llm', to: 'user', type: 'response', stepIndex: curGlobal,
          label: step.responseText.slice(0, 100),
          detail: step.responseText,
          depth, convLabel,
          meta: { outputTokens: step.outputTokens },
        });
      }
    }
  }

  addConvMessages(conv, 0);
  return msgs;
}

function getNodeTypeClass(msg) {
  if (msg.type === 'request') return 'node-request';
  if (msg.type === 'response') return 'node-response';
  if (msg.type === 'thinking') return 'node-thinking';
  if (msg.type === 'call') return msg.to === 'agents' ? 'node-agent-call' : 'node-tool-call';
  if (msg.type === 'result') return msg.from === 'agents' ? 'node-agent-result' : 'node-tool-result';
  return '';
}

function getNodeIcon(msg) {
  if (msg.type === 'request') return '&#128172;';    // speech bubble
  if (msg.type === 'response') return '&#128161;';   // lightbulb
  if (msg.type === 'thinking') return '&#129504;';   // brain
  if (msg.type === 'call' && msg.to === 'agents') return '&#129302;'; // robot
  if (msg.type === 'call') return '&#128295;';       // wrench
  if (msg.type === 'result') return '&#8592;';       // left arrow
  return '&#8226;';
}

function renderDiagram() {
  const conv = getCurrentConv();
  const el = document.getElementById('sim-diagram');
  const cur = simState.currentStep;

  if (!conv) { el.innerHTML = ''; return; }

  // Build unified messages (main + sub-agents merged)
  const unifiedMsgs = buildUnifiedMessages(conv);
  simState.unifiedMsgs = unifiedMsgs;
  const total = unifiedMsgs.length > 0 ? Math.max(...unifiedMsgs.map(m => m.stepIndex)) + 1 : 0;

  // Update controls
  const stepBtn = document.getElementById('sim-step');
  const playBtn2 = document.getElementById('sim-play');
  const stepLabel = document.getElementById('sim-step-label');
  if (stepBtn) stepBtn.disabled = !conv || cur >= total - 1;
  if (playBtn2) playBtn2.disabled = !conv;
  if (stepLabel) stepLabel.textContent = cur < 0 ? 'Ready' : 'Step ' + (cur + 1) + ' / ' + total;

  let html = '';

  // Legend
  html += '<div class="flow-legend">';
  html += '<div class="flow-legend-item"><div class="flow-legend-swatch sw-user"></div>User</div>';
  html += '<div class="flow-legend-item"><div class="flow-legend-swatch sw-thinking"></div>Thinking</div>';
  html += '<div class="flow-legend-item"><div class="flow-legend-swatch sw-tool"></div>Tool</div>';
  html += '<div class="flow-legend-item"><div class="flow-legend-swatch sw-agent"></div>Agent</div>';
  html += '<div class="flow-legend-item"><div class="flow-legend-swatch sw-response"></div>Response</div>';
  html += '<span style="flex:1"></span>';
  html += '<span style="font-size:10px;color:var(--text-muted)">' + esc(conv.modelClass) + '</span>';
  html += '</div>';

  // Context meter (use first available step data)
  const allSteps = conv.steps || [];
  const maxCtx = Math.max(...allSteps.map(s => s.totalInput), 1);
  const curStepData = cur >= 0 && cur < allSteps.length ? allSteps[cur] : null;
  const ctxPct = curStepData ? ((curStepData.totalInput / maxCtx) * 100) : 0;
  const ctxTokens = curStepData ? curStepData.totalInput : 0;

  html += '<div class="ctx-meter">';
  html += '<span style="color:var(--text-muted);font-size:11px">Context:</span>';
  html += '<div class="ctx-bar-bg"><div class="ctx-bar" style="width:' + ctxPct + '%"></div></div>';
  html += '<div class="ctx-label">' + fmtTokens(ctxTokens) + ' tokens</div>';
  html += '</div>';

  // Group messages by stepIndex
  const stepGroups = [];
  let lastStep = -1;
  for (const msg of unifiedMsgs) {
    if (msg.stepIndex !== lastStep) {
      stepGroups.push([]);
      lastStep = msg.stepIndex;
    }
    stepGroups[stepGroups.length - 1].push(msg);
  }

  // Flowchart: render nodes in rows, max N per row
  const NODES_PER_ROW = 5;
  html += '<div class="flow-canvas">';
  html += '<div class="flow-nodes">';

  let rowGroups = [];
  for (let i = 0; i < stepGroups.length; i += NODES_PER_ROW) {
    rowGroups.push(stepGroups.slice(i, i + NODES_PER_ROW));
  }

  for (let ri = 0; ri < rowGroups.length; ri++) {
    const row = rowGroups[ri];
    const isReverse = ri % 2 === 1;
    const displayRow = isReverse ? [...row].reverse() : row;

    html += '<div class="flow-row' + (isReverse ? ' reverse' : '') + '">';

    for (let gi = 0; gi < displayRow.length; gi++) {
      const group = displayRow[gi];
      const stepIdx = group[0].stepIndex;
      const visible = stepIdx <= cur;
      const isCurrent = stepIdx === cur;

      if (gi > 0) {
        const arrowChar = isReverse ? '&#8592;' : '&#8594;';
        html += '<div class="flow-arrow' + (visible ? ' visible' : '') + '">' + arrowChar + '</div>';
      }

      html += '<div class="flow-group" data-step="' + stepIdx + '">';

      for (const msg of group) {
        const nodeClass = getNodeTypeClass(msg);
        const icon = getNodeIcon(msg);
        const depthClass = msg.depth > 0 ? ' depth-' + Math.min(msg.depth, 3) : '';
        const cls = 'flow-node ' + nodeClass + depthClass + (visible ? ' visible' : '') + (isCurrent ? ' current' : '');

        html += '<div class="' + cls + '" onclick="this.classList.toggle(&quot;expanded&quot;)" data-step="' + msg.stepIndex + '">';

        // Sub-agent depth indicator
        if (msg.depth > 0) {
          html += '<div class="flow-depth-tag">' + (msg.convLabel || 'sub') + '</div>';
        }

        html += '<span class="flow-icon">' + icon + '</span>';
        html += '<span class="flow-label">' + esc(msg.label) + '</span>';
        if (msg.meta) {
          html += '<div class="flow-meta">';
          if (msg.meta.tokens) html += fmtTokens(msg.meta.tokens) + ' tok';
          if (msg.meta.cache !== undefined) html += ' &middot; cache: <span class="' + cacheClass(msg.meta.cache) + '">' + msg.meta.cache + '%</span>';
          if (msg.meta.outputTokens) html += fmtTokens(msg.meta.outputTokens) + ' out';
          html += '</div>';
        }
        if (msg.detail) {
          html += '<div class="flow-detail">' + esc(msg.detail) + '</div>';
        }
        html += '</div>';
      }

      html += '</div>'; // flow-group
    }

    html += '</div>'; // flow-row

    // Down arrow between rows
    if (ri < rowGroups.length - 1) {
      const nextRow = rowGroups[ri + 1];
      const nextRowVisible = nextRow && nextRow[0] && nextRow[0][0] ? nextRow[0][0].stepIndex <= cur : false;
      const downPos = isReverse ? 'flex-start' : 'flex-end';
      html += '<div style="width:100%;display:flex;justify-content:' + downPos + ';padding:0 40px">';
      html += '<div class="flow-arrow' + (nextRowVisible ? ' visible' : '') + '" style="transform:rotate(90deg)">&#8594;</div>';
      html += '</div>';
    }
  }

  html += '</div>'; // flow-nodes
  html += '</div>'; // flow-canvas

  el.innerHTML = html;
}

function renderRawCalls(calls) {
  let rows = '';
  for (const c of calls) {
    if (c.method === 'HEAD') continue; // skip health checks
    const cacheClz = cacheClass(c.cacheHitRate);
    rows += \`
      <tr class="raw-row">
        <td class="num">\${c.index + 1}</td>
        <td>\${fmtTime(c.timestamp)}</td>
        <td><span class="badge badge-\${c.modelClass}">\${esc(c.modelClass)}</span></td>
        <td class="num">\${c.statusCode || '-'}</td>
        <td class="num">\${fmtDuration(c.latency)}</td>
        <td class="num">\${fmtTokens(c.totalInput)}</td>
        <td class="num">\${fmtTokens(c.outputTokens)}</td>
        <td class="num \${cacheClz}">\${c.cacheHitRate.toFixed(1)}%</td>
        <td class="num">\${c.messageCount} msgs</td>
      </tr>
      <tr class="raw-detail">
        <td colspan="9">
          <div style="display:flex;gap:24px;flex-wrap:wrap">
            <div style="flex:1;min-width:300px">
              <div style="color:var(--green);font-weight:600;font-size:11px;text-transform:uppercase;margin-bottom:6px">Request</div>
              <div style="margin-bottom:6px"><strong>User:</strong> \${esc((c.firstUserText || '').slice(0, 120))}\${(c.firstUserText||'').length > 120 ? '...' : ''}</div>
              <div style="margin-bottom:6px;color:var(--text-muted);font-size:11px">Message structure: \${(c.msgStructure || []).join(' → ')}</div>
              \${c.requestToolCalls && c.requestToolCalls.length > 0 ? '<div style="margin-bottom:4px"><strong>Tool calls in request:</strong></div>' + c.requestToolCalls.map(t => '<div class="tool-call tool-category-' + t.category + '"><span class="tool-icon">' + toolIcon(t.category) + '</span><span class="tool-name">' + esc(t.name) + '</span><span class="tool-desc"> ' + esc(t.summary) + '</span></div>').join('') : ''}
            </div>
            <div style="flex:1;min-width:300px">
              <div style="color:var(--accent);font-weight:600;font-size:11px;text-transform:uppercase;margin-bottom:6px">Response</div>
              <div style="margin-bottom:6px">
                <strong>Cache:</strong> read=\${fmtTokens(c.cacheRead)} create=\${fmtTokens(c.cacheCreation)} uncached=\${fmtTokens(c.inputTokens)}
              </div>
              \${c.responseText ? '<div class="collapsible-toggle"><span class="indicator">[+]</span> Response text (' + c.responseText.length + ' chars)</div><div class="collapsible-content"><div class="tool-result">' + esc(c.responseText.slice(0, 2000)) + '</div></div>' : '<div style="color:var(--text-muted)">No text response</div>'}
              \${c.thinkingText ? '<div class="collapsible-toggle"><span class="indicator">[+]</span> Thinking</div><div class="collapsible-content"><div class="thinking-block">' + esc(c.thinkingText.slice(0, 1000)) + '</div></div>' : ''}
            </div>
          </div>
        </td>
      </tr>\`;
  }

  return \`
    <table class="raw-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Time</th>
          <th>Model</th>
          <th>Status</th>
          <th>Latency</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cache Hit</th>
          <th>Msgs</th>
        </tr>
      </thead>
      <tbody>\${rows}</tbody>
    </table>\`;
}
`;
}

// ── Exports for server.js ────────────────────────────────────────────────────
export { parseJSONL, buildRawCalls, buildConversations, buildRawEntries };

// ── CLI mode ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isCLI = args.length >= 1 && process.argv[1]?.endsWith('generate-report.js');

if (isCLI) {
  const inputFile = args[0];
  const outputFile = args[1] || inputFile.replace('.jsonl', '.html');

  if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
  }
  console.log(`Parsing ${inputFile}...`);
  let entries = parseJSONL(inputFile);

  // Auto-discover and load subagent files
  const dir = path.dirname(inputFile);
  const base = path.basename(inputFile, '.jsonl');
  const subagentsDir = path.join(dir, base, 'subagents');
  if (fs.existsSync(subagentsDir) && fs.statSync(subagentsDir).isDirectory()) {
    const subFiles = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl'));
    for (const sf of subFiles) {
      const subEntries = parseJSONL(path.join(subagentsDir, sf));
      entries = entries.concat(subEntries);
      console.log(`  + ${sf} (${subEntries.length} entries)`);
    }
    entries.sort((a, b) => (a.request?.timestamp || 0) - (b.request?.timestamp || 0));
  }
  console.log(`Found ${entries.length} entries`);

  const rawCalls = buildRawCalls(entries);
  const conversations = buildConversations(entries);
  console.log(`Built ${conversations.length} conversations (${conversations.filter(c => c.isMainThread).length} main threads)`);

  const rawEntries = buildRawEntries(entries);
  const html = generateHTML(rawCalls, conversations, rawEntries, inputFile);
  fs.writeFileSync(outputFile, html);
  console.log(`Report written to ${outputFile}`);
}
