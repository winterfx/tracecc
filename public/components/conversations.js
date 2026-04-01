// ConversationsTab — port of ConversationsTab.tsx
import { toolIcon, toolNameClass, toolSummary, modelBadgeClass, formatTime, simpleMarkdown, escapeHtml } from '../shared/utils.js'

function renderToolLine(tool) {
  const summary = toolSummary(tool)
  return `<div class="tool-line">
    <span class="tool-icon">${toolIcon(tool.category)}</span>
    <span class="tool-name ${toolNameClass(tool.category)}">${escapeHtml(tool.name)}</span>
    ${summary ? `<span class="tool-summary">${escapeHtml(summary)}</span>` : ''}
  </div>`
}

function renderTurn(turn, turnNum, isLast) {
  if (turn.type === 'user') {
    if (!turn.content.text && turn.toolResults.length > 0) return ''
    if (!turn.content.text) return ''
    return `<div class="conv-turn">
      <div class="conv-turn-label conv-turn-label--user">Turn ${turnNum} &mdash; User</div>
      <div style="white-space:pre-wrap;word-break:break-word;color:#e0e0e0;font-size:12px;">${escapeHtml(turn.content.text)}</div>
    </div>`
  }

  // Assistant turn
  const hasThinking = !!turn.content.thinking
  const hasText = !!turn.content.text
  const hasTools = turn.toolCalls.length > 0
  let html = `<div class="conv-turn">
    <div class="conv-turn-label conv-turn-label--assistant">Turn ${turnNum} &mdash; Assistant</div>`

  if (hasThinking) {
    const id = 'think-' + Math.random().toString(36).slice(2, 8)
    html += `<div class="toggle-header" data-toggle-target="${id}">
      <span class="toggle-indicator">[+]</span> Thinking...
    </div>
    <div class="toggle-body collapsible-content collapsible-content--thinking" id="${id}">${escapeHtml(turn.content.thinking)}</div>`
  }

  if (hasTools) {
    turn.toolCalls.forEach(tool => {
      html += renderToolLine(tool)
      // Matching tool results
      turn.toolResults.filter(r => r.toolUseId === tool.id).forEach(result => {
        const rid = 'res-' + Math.random().toString(36).slice(2, 8)
        const errClass = result.isError ? ' collapsible-content--error' : ''
        html += `<div class="toggle-header" data-toggle-target="${rid}">
          <span class="toggle-indicator">[+]</span> Result (${(result.content || '').length} chars)
        </div>
        <div class="toggle-body collapsible-content${errClass}" id="${rid}">${escapeHtml(result.content)}</div>`
      })
    })
  }

  if (hasText) {
    if (isLast || (!hasTools && hasText)) {
      html += `<div class="md-content mt-2">${simpleMarkdown(turn.content.text)}</div>`
    } else if (hasTools) {
      html += `<div style="font-size:12px;color:#808080;margin-top:4px;white-space:pre-wrap;">${escapeHtml(turn.content.text.slice(0, 200))}</div>`
    }
  }

  html += '</div>'
  return html
}

function renderConversationCard(conv, defaultOpen = false) {
  const userPreview = conv.firstUserText.slice(0, 80) + (conv.firstUserText.length > 80 ? '...' : '')
  const badgeClass = modelBadgeClass(conv.modelClass)
  const cardId = 'conv-' + Math.random().toString(36).slice(2, 8)

  let bodyHtml = ''

  // System prompt
  if (conv.systemPrompt) {
    const sid = 'sp-' + Math.random().toString(36).slice(2, 8)
    bodyHtml += `<div style="padding:12px 14px;">
      <div class="toggle-header" data-toggle-target="${sid}">
        <span class="toggle-indicator">[+]</span> System Prompt (${conv.systemPrompt.length.toLocaleString()} chars)
      </div>
      <div class="toggle-body collapsible-content collapsible-content--tall" id="${sid}">${escapeHtml(conv.systemPrompt)}</div>
    </div>`
  }

  // Tool definitions
  if (conv.toolDefs && conv.toolDefs.length > 0) {
    const tid = 'td-' + Math.random().toString(36).slice(2, 8)
    bodyHtml += `<div class="conv-turn">
      <div class="toggle-header" data-toggle-target="${tid}">
        <span class="toggle-indicator">[+]</span> Tools (${conv.toolDefs.length})
      </div>
      <div class="toggle-body collapsible-content" id="${tid}">
        ${conv.toolDefs.map(td =>
          `<div style="padding:2px 0;"><span style="color:var(--accent-yellow);font-weight:600;">${escapeHtml(td.name)}</span> <span style="color:#808080;margin-left:4px;">${escapeHtml(td.description)}</span></div>`
        ).join('')}
      </div>
    </div>`
  }

  // Turns
  conv.turns.forEach((turn, i) => {
    bodyHtml += renderTurn(turn, i + 1, i === conv.turns.length - 1)
  })

  // Sub-agents
  if (conv.subAgents && conv.subAgents.length > 0) {
    bodyHtml += `<div class="conv-turn">
      <div style="color:var(--accent-purple);font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:8px;">Sub-Agents</div>
      ${conv.subAgents.map(sub => renderConversationCard(sub, false)).join('')}
    </div>`
  }

  return `<div class="conv-card">
    <div class="conv-header" data-conv-toggle>
      <div class="conv-header-left">
        <span class="toggle-indicator">${defaultOpen ? '[-]' : '[+]'}</span>
        <span class="conv-preview">${escapeHtml(userPreview)}</span>
        <span class="badge ${badgeClass}">${escapeHtml(conv.model)}</span>
      </div>
      <div class="conv-header-right">
        ${conv.totalRounds} rounds &middot; ${formatTime(conv.startTime)}
      </div>
    </div>
    <div class="conv-card-body" style="display:${defaultOpen ? 'block' : 'none'}">
      ${bodyHtml}
    </div>
  </div>`
}

export function renderConversationsTab(container, conversations) {
  if (!conversations || conversations.length === 0) {
    container.innerHTML = '<div style="color:#808080;margin-top:16px;">No conversations found</div>'
    return
  }

  const mainThreads = conversations.filter(c => c.isMainThread)
  const linkedSubAgentIds = new Set()
  mainThreads.forEach(m => (m.subAgents || []).forEach(s => linkedSubAgentIds.add(s.id)))
  const orphans = conversations.filter(c => !c.isMainThread && !linkedSubAgentIds.has(c.id))

  let html = '<div class="mt-4" style="font-size:13px;">'
  mainThreads.forEach(conv => { html += renderConversationCard(conv, false) })

  if (orphans.length > 0) {
    html += '<div class="mt-4" style="color:#808080;font-size:12px;">Other conversations</div>'
    orphans.forEach(conv => { html += renderConversationCard(conv, false) })
  }

  html += '</div>'
  container.innerHTML = html

  // Wire up conversation card expand/collapse
  container.querySelectorAll('[data-conv-toggle]').forEach(header => {
    header.addEventListener('click', e => {
      e.stopPropagation()
      const body = header.parentElement.querySelector('.conv-card-body')
      const ind = header.querySelector('.toggle-indicator')
      if (body.style.display === 'none') {
        body.style.display = 'block'
        if (ind) ind.textContent = '[-]'
      } else {
        body.style.display = 'none'
        if (ind) ind.textContent = '[+]'
      }
    })
  })

  // Wire up all collapsibles
  container.querySelectorAll('[data-toggle-target]').forEach(header => {
    const targetId = header.dataset.toggleTarget
    const body = container.querySelector('#' + targetId)
    if (!body) return
    const indicator = header.querySelector('.toggle-indicator')
    header.addEventListener('click', e => {
      e.stopPropagation()
      const isOpen = body.classList.toggle('toggle-body--open')
      if (indicator) indicator.textContent = isOpen ? '[-]' : '[+]'
    })
  })
}
