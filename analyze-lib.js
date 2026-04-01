/**
 * tracecc log analyzer — reusable library module
 *
 * Exports:
 *   extractSSEUsage(bodyRaw) — parse SSE body_raw for usage/model
 *   parseLogFiles(filePaths)  — read JSONL files, return structured records
 *   computeAnalysis(records, filePaths) — return full analysis as JSON
 *   detectFormat(entries) — detect JSONL format ('proxy' or 'claude-code')
 *   convertCCEntries(entries) — convert Claude Code JSONL entries to proxy format
 */

import fs from 'fs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const avg = (arr) => (arr.length ? sum(arr) / arr.length : 0);
const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) + '%' : 'N/A');
const pctNum = (n, d) => (d > 0 ? parseFloat(((n / d) * 100).toFixed(1)) : 0);
const fmtCost = (n) => '$' + n.toFixed(6);
const fmtSec = (n) => n.toFixed(2) + 's';

// ─── Extract usage from SSE body_raw ─────────────────────────────────────────

export function extractSSEUsage(bodyRaw) {
  if (!bodyRaw) return null;

  let usage = null;
  let finalOutputTokens = 0;
  let model = null;

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
    } catch {}
  }

  if (usage) {
    usage.output_tokens = finalOutputTokens || usage.output_tokens || 0;
  }

  return { usage, model };
}

// ─── Detect JSONL format ─────────────────────────────────────────────────────

const CC_TYPES = new Set(['user', 'assistant', 'system', 'file-history-snapshot']);

export function detectFormat(entries) {
  for (const e of entries) {
    if (e.request && e.response) return 'proxy';
    if (CC_TYPES.has(e.type)) return 'claude-code';
  }
  return 'proxy'; // default fallback
}

// ─── Convert Claude Code JSONL entries to proxy format ──────────────────────

export function convertCCEntries(ccEntries) {
  // Filter to meaningful messages only
  const messages = ccEntries.filter(e =>
    (e.type === 'user' || e.type === 'assistant') && !e.isMeta
  );

  const proxyEntries = [];
  // Accumulate messages to build the growing conversation context
  const allMessages = [];
  let pendingUserMsgs = [];

  for (const entry of messages) {
    if (entry.type === 'user') {
      pendingUserMsgs.push(entry);
      allMessages.push({
        role: 'user',
        content: entry.message?.content,
      });
      continue;
    }

    if (entry.type === 'assistant') {
      const usage = entry.message?.usage;
      const model = entry.message?.model;
      const content = entry.message?.content;

      // Add this assistant message to the running context
      allMessages.push({
        role: 'assistant',
        content: content,
      });

      // Timestamp: use first pending user msg or the assistant msg itself
      const userTs = pendingUserMsgs.length > 0
        ? new Date(pendingUserMsgs[0].timestamp).getTime() / 1000
        : new Date(entry.timestamp).getTime() / 1000;
      const assistantTs = new Date(entry.timestamp).getTime() / 1000;

      // Build a snapshot of the messages array as it would appear in the API request
      const messagesSnapshot = allMessages.map(m => ({ ...m }));

      // Collect uuid chain metadata from pending user msgs and this assistant
      const userUuids = pendingUserMsgs.map(u => u.uuid).filter(Boolean);

      proxyEntries.push({
        request: {
          timestamp: userTs,
          method: 'POST',
          url: '',
          headers: {},
          body: {
            model: model || 'unknown',
            messages: messagesSnapshot,
            stream: true,
          },
        },
        response: {
          timestamp: assistantTs,
          status_code: 200,
          headers: {},
          body: null,
          body_raw: null,
        },
        _ccUsage: usage || null,
        _ccModel: model || null,
        _ccContent: content || [],
        _source: 'claude-code',
        // CC uuid chain metadata for conversation tree building
        _ccUuid: entry.uuid || null,
        _ccParentUuid: entry.parentUuid || null,
        _ccSessionId: entry.sessionId || null,
        _ccIsSidechain: entry.isSidechain || false,
        _ccSourceToolAssistantUUID: entry.sourceToolAssistantUUID || null,
        _ccUserUuids: userUuids,
      });

      pendingUserMsgs = [];
    }
  }

  // Also convert api_error entries
  for (const entry of ccEntries) {
    if (entry.type === 'system' && entry.subtype === 'api_error') {
      const ts = new Date(entry.timestamp).getTime() / 1000;
      proxyEntries.push({
        request: {
          timestamp: ts,
          method: 'POST',
          url: '',
          headers: {},
          body: { model: 'unknown', messages: [] },
        },
        response: {
          timestamp: ts,
          status_code: entry.error?.status || 500,
          headers: {},
          body: null,
          body_raw: null,
        },
        _source: 'claude-code',
      });
    }
  }

  // Sort by request timestamp
  proxyEntries.sort((a, b) => (a.request.timestamp || 0) - (b.request.timestamp || 0));

  return proxyEntries;
}

// ─── Parse JSONL log files into structured records ───────────────────────────

export function parseLogFiles(filePaths) {
  const entries = [];

  for (const file of filePaths) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const parsed = [];
    for (const line of lines) {
      try { parsed.push(JSON.parse(line)); } catch {}
    }

    // Detect format and convert if needed
    const format = detectFormat(parsed);
    const fileEntries = format === 'claude-code' ? convertCCEntries(parsed) : parsed;
    for (const entry of fileEntries) {
      entry._file = file;
      entries.push(entry);
    }
  }

  return entries.map((e) => {
    const reqBody = e.request?.body || {};
    const respHeaders = e.response?.headers || {};
    // Use CC usage directly if available, otherwise extract from SSE
    const sseData = e._ccUsage
      ? { usage: e._ccUsage, model: e._ccModel }
      : extractSSEUsage(e.response?.body_raw);
    const usage = sseData?.usage || {};

    const inputTokens = usage.input_tokens || 0;
    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const ephemeral5m = usage.cache_creation?.ephemeral_5m_input_tokens || 0;
    const ephemeral1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const totalInput = inputTokens + cacheCreation + cacheRead;

    return {
      file: e._file,
      timestamp: e.request?.timestamp,
      method: e.request?.method,
      url: e.request?.url,
      model: reqBody.model || sseData?.model || 'unknown',
      hasThinking: !!reqBody.thinking,
      hasTools: Array.isArray(reqBody.tools) && reqBody.tools.length > 0,
      toolCount: Array.isArray(reqBody.tools) ? reqBody.tools.length : 0,
      stream: !!reqBody.stream,
      statusCode: e.response?.status_code,
      latency: (e.response?.timestamp || 0) - (e.request?.timestamp || 0),
      ttft: (e.response?.first_chunk_timestamp || e.response?.timestamp || 0) - (e.request?.timestamp || 0),
      inputTokens,
      cacheCreation,
      cacheRead,
      ephemeral5m,
      ephemeral1h,
      outputTokens,
      totalInput,
      cost: parseFloat(respHeaders['x-litellm-response-cost-original'] || '0'),
      costDiscount: parseFloat(respHeaders['x-litellm-response-cost-discount-amount'] || '0'),
      keySpend: parseFloat(respHeaders['x-litellm-key-spend'] || '0'),
      messageCount: Array.isArray(reqBody.messages) ? reqBody.messages.length : 0,
    };
  });
}

// ─── Compute full analysis from records ──────────────────────────────────────

export function computeAnalysis(records, filePaths) {
  if (!records || records.length === 0) {
    return { error: 'No valid log entries found.' };
  }

  // Model groups
  const modelGroups = {};
  for (const r of records) {
    if (!modelGroups[r.model]) modelGroups[r.model] = [];
    modelGroups[r.model].push(r);
  }

  // ─── 1. Overview ─────────────────────────────────────────────────────────
  const timestamps = records.map((r) => r.timestamp).filter(Boolean);
  const overview = {
    logFiles: filePaths,
    totalRequests: records.length,
    timeRange: {
      start: timestamps.length ? new Date(Math.min(...timestamps) * 1000).toISOString() : null,
      end: timestamps.length ? new Date(Math.max(...timestamps) * 1000).toISOString() : null,
    },
  };

  // ─── 2. Cost Efficiency ──────────────────────────────────────────────────
  const totalCost = sum(records.map((r) => r.cost));
  const totalDiscount = sum(records.map((r) => r.costDiscount));
  const totalTokensAll = sum(records.map((r) => r.totalInput + r.outputTokens));

  const costByModel = Object.entries(modelGroups).map(([model, recs]) => ({
    model,
    requests: recs.length,
    totalCost: sum(recs.map((r) => r.cost)),
    avgCost: avg(recs.map((r) => r.cost)),
  }));

  const cost = {
    totalCost,
    totalDiscount,
    netCost: totalCost - totalDiscount,
    avgCostPerRequest: avg(records.map((r) => r.cost)),
    costPer1kTokens: totalTokensAll > 0 ? (totalCost / totalTokensAll) * 1000 : 0,
    byModel: costByModel,
  };

  // ─── 3. Token Usage ──────────────────────────────────────────────────────
  const totalInputTokens = sum(records.map((r) => r.inputTokens));
  const totalCacheCreation = sum(records.map((r) => r.cacheCreation));
  const totalCacheRead = sum(records.map((r) => r.cacheRead));
  const totalOutputTokens = sum(records.map((r) => r.outputTokens));
  const totalEph5m = sum(records.map((r) => r.ephemeral5m));
  const totalEph1h = sum(records.map((r) => r.ephemeral1h));
  const grandTotalInput = totalInputTokens + totalCacheCreation + totalCacheRead;

  const tokens = {
    totalInput: grandTotalInput,
    nonCacheInput: totalInputTokens,
    cacheCreation: totalCacheCreation,
    cacheRead: totalCacheRead,
    totalOutput: totalOutputTokens,
    inputOutputRatio: totalOutputTokens > 0 ? parseFloat((grandTotalInput / totalOutputTokens).toFixed(1)) : 0,
    avgInputPerRequest: Math.round(avg(records.map((r) => r.totalInput))),
    avgOutputPerRequest: Math.round(avg(records.map((r) => r.outputTokens))),
  };

  // ─── 4. Cache Performance ────────────────────────────────────────────────
  const cacheRecords = records.filter((r) => r.totalInput > 0);
  const perRequestCache = cacheRecords.map((r, i) => ({
    index: i + 1,
    model: r.model,
    cacheRead: r.cacheRead,
    totalInput: r.totalInput,
    hitRate: pctNum(r.cacheRead, r.totalInput),
  }));

  const cache = {
    hitRate: pctNum(totalCacheRead, grandTotalInput),
    creationRate: pctNum(totalCacheCreation, grandTotalInput),
    nonCacheRate: pctNum(totalInputTokens, grandTotalInput),
    ephemeral5mTokens: totalEph5m,
    ephemeral1hTokens: totalEph1h,
    perRequest: perRequestCache,
  };

  // ─── 5. Request Efficiency ───────────────────────────────────────────────
  const successCount = records.filter((r) => r.statusCode >= 200 && r.statusCode < 300).length;
  const errorCount = records.filter((r) => r.statusCode >= 400).length;
  const toolCount = records.filter((r) => r.hasTools).length;
  const thinkingCount = records.filter((r) => r.hasThinking).length;
  const streamCount = records.filter((r) => r.stream).length;

  const requestEfficiency = {
    totalRequests: records.length,
    success: { count: successCount, pct: pctNum(successCount, records.length) },
    errors: { count: errorCount, pct: pctNum(errorCount, records.length) },
    withTools: { count: toolCount, pct: pctNum(toolCount, records.length) },
    withThinking: { count: thinkingCount, pct: pctNum(thinkingCount, records.length) },
    streaming: { count: streamCount, pct: pctNum(streamCount, records.length) },
  };

  // ─── 6. Latency ──────────────────────────────────────────────────────────
  const latencies = records.map((r) => r.latency).filter((l) => l > 0);
  latencies.sort((a, b) => a - b);

  const latencyByModel = Object.entries(modelGroups).map(([model, recs]) => {
    const ls = recs.map((r) => r.latency).filter((l) => l > 0).sort((a, b) => a - b);
    return {
      model,
      requests: recs.length,
      avg: ls.length > 0 ? parseFloat(avg(ls).toFixed(2)) : 0,
      p50: ls.length > 0 ? parseFloat(ls[Math.floor(ls.length * 0.5)].toFixed(2)) : 0,
      p99: ls.length > 0 ? parseFloat(ls[Math.floor(ls.length * 0.99)].toFixed(2)) : 0,
      max: ls.length > 0 ? parseFloat(ls[ls.length - 1].toFixed(2)) : 0,
    };
  });

  const latency = {
    avg: latencies.length > 0 ? parseFloat(avg(latencies).toFixed(2)) : 0,
    min: latencies.length > 0 ? parseFloat(latencies[0].toFixed(2)) : 0,
    max: latencies.length > 0 ? parseFloat(latencies[latencies.length - 1].toFixed(2)) : 0,
    p50: latencies.length > 0 ? parseFloat(latencies[Math.floor(latencies.length * 0.5)].toFixed(2)) : 0,
    p90: latencies.length > 0 ? parseFloat(latencies[Math.floor(latencies.length * 0.9)].toFixed(2)) : 0,
    p99: latencies.length > 0 ? parseFloat(latencies[Math.floor(latencies.length * 0.99)].toFixed(2)) : 0,
    byModel: latencyByModel,
  };

  // ─── 6b. TTFT (Time to First Token) ───────────────────────────────────────
  const ttftValues = records.map((r) => r.ttft).filter((t) => t > 0);
  ttftValues.sort((a, b) => a - b);

  const ttftByModel = Object.entries(modelGroups).map(([model, recs]) => {
    const ts = recs.map((r) => r.ttft).filter((t) => t > 0).sort((a, b) => a - b);
    return {
      model,
      requests: recs.length,
      avg: ts.length > 0 ? parseFloat(avg(ts).toFixed(3)) : 0,
      p50: ts.length > 0 ? parseFloat(ts[Math.floor(ts.length * 0.5)].toFixed(3)) : 0,
      p99: ts.length > 0 ? parseFloat(ts[Math.floor(ts.length * 0.99)].toFixed(3)) : 0,
    };
  });

  const ttft = {
    avg: ttftValues.length > 0 ? parseFloat(avg(ttftValues).toFixed(3)) : 0,
    min: ttftValues.length > 0 ? parseFloat(ttftValues[0].toFixed(3)) : 0,
    max: ttftValues.length > 0 ? parseFloat(ttftValues[ttftValues.length - 1].toFixed(3)) : 0,
    p50: ttftValues.length > 0 ? parseFloat(ttftValues[Math.floor(ttftValues.length * 0.5)].toFixed(3)) : 0,
    p99: ttftValues.length > 0 ? parseFloat(ttftValues[Math.floor(ttftValues.length * 0.99)].toFixed(3)) : 0,
    byModel: ttftByModel,
    perRequest: records.filter((r) => r.ttft > 0).map((r, i) => ({
      index: i + 1,
      model: r.model,
      ttft: parseFloat(r.ttft.toFixed(3)),
    })),
  };

  // ─── 7. Model Selection ──────────────────────────────────────────────────
  const modelSelection = Object.entries(modelGroups).map(([model, recs]) => ({
    model,
    requests: recs.length,
    share: pctNum(recs.length, records.length),
    totalTokens: sum(recs.map((r) => r.totalInput + r.outputTokens)),
  }));

  // ─── 8. Context Growth ───────────────────────────────────────────────────
  const contextRecords = records.filter((r) => r.totalInput > 0);
  const contextGrowth = {
    points: contextRecords.map((r, i) => ({
      index: i + 1,
      model: r.model,
      totalInput: r.totalInput,
    })),
    first: contextRecords.length > 0 ? contextRecords[0].totalInput : 0,
    last: contextRecords.length > 0 ? contextRecords[contextRecords.length - 1].totalInput : 0,
    growth: contextRecords.length > 1
      ? contextRecords[contextRecords.length - 1].totalInput - contextRecords[0].totalInput
      : 0,
    growthPct: contextRecords.length > 1
      ? pctNum(
          contextRecords[contextRecords.length - 1].totalInput - contextRecords[0].totalInput,
          contextRecords[0].totalInput,
        )
      : 0,
  };

  // ─── 9. Per-file Summary ─────────────────────────────────────────────────
  const fileGroups = {};
  for (const r of records) {
    if (!fileGroups[r.file]) fileGroups[r.file] = [];
    fileGroups[r.file].push(r);
  }
  const perFile = Object.entries(fileGroups).map(([file, recs]) => {
    const ts = recs.map((r) => r.timestamp).filter(Boolean);
    const duration = ts.length > 1 ? Math.max(...ts) - Math.min(...ts) : 0;
    return {
      file: file.split('/').pop(),
      requests: recs.length,
      duration: parseFloat(duration.toFixed(2)),
      cost: sum(recs.map((r) => r.cost)),
      totalTokens: sum(recs.map((r) => r.totalInput + r.outputTokens)),
    };
  });

  // ─── 10. Efficiency Score ────────────────────────────────────────────────
  const cacheHitRate = grandTotalInput > 0 ? totalCacheRead / grandTotalInput : 0;
  const errorRate = records.length > 0 ? errorCount / records.length : 0;
  const avgLatencyVal = latencies.length > 0 ? avg(latencies) : 0;
  const ioRatio = totalOutputTokens > 0 ? grandTotalInput / totalOutputTokens : 0;

  const avgTTFT = ttftValues.length > 0 ? avg(ttftValues) : 0;

  const efficiencyScore = {
    cacheHitRate: parseFloat((cacheHitRate * 100).toFixed(1)),
    errorRate: parseFloat((errorRate * 100).toFixed(1)),
    avgLatency: parseFloat(avgLatencyVal.toFixed(2)),
    avgTTFT: parseFloat(avgTTFT.toFixed(3)),
    inputOutputRatio: parseFloat(ioRatio.toFixed(1)),
    totalCost,
    totalRequests: records.length,
  };

  return {
    overview,
    cost,
    tokens,
    cache,
    requestEfficiency,
    latency,
    ttft,
    modelSelection,
    contextGrowth,
    perFile,
    efficiencyScore,
  };
}
