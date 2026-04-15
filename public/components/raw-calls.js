// RawCallsTab — port of RawCallsTab.tsx
import { formatTime, formatTokens, formatDuration, cacheColorClass, modelBadgeClass, toolIcon, toolNameClass, escapeHtml } from '../shared/utils.js'

function renderCallDetail(call) {
  let reqHtml = `<div style="flex:1;min-width:300px;">
    <div style="color:var(--accent-green);font-weight:600;font-size:11px;text-transform:uppercase;margin-bottom:6px;">Request</div>
    <div style="margin-bottom:6px;font-size:12px;">
      <strong style="color:#e0e0e0;">User:</strong>
      <span style="color:#ccc;">${escapeHtml((call.firstUserText || '').slice(0, 120))}${(call.firstUserText || '').length > 120 ? '...' : ''}</span>
    </div>
    <div style="color:#808080;font-size:11px;margin-bottom:6px;">
      Message structure: ${(call.msgStructure || []).join(' \u2192 ')}
    </div>`

  if (call.requestToolCalls && call.requestToolCalls.length > 0) {
    reqHtml += '<div style="font-size:12px;margin-bottom:4px;"><strong style="color:#e0e0e0;">Tool calls in request:</strong></div>'
    call.requestToolCalls.forEach(t => {
      reqHtml += `<div class="tool-line">
        <span class="tool-icon">${toolIcon(t.category)}</span>
        <span class="tool-name ${toolNameClass(t.category)}">${escapeHtml(t.name)}</span>
        <span class="tool-summary">${escapeHtml(t.summary)}</span>
      </div>`
    })
  }
  reqHtml += '</div>'

  let resHtml = `<div style="flex:1;min-width:300px;">
    <div style="color:var(--accent-blue);font-weight:600;font-size:11px;text-transform:uppercase;margin-bottom:6px;">Response</div>
    <div style="color:#808080;font-size:11px;margin-bottom:6px;">
      Cache: read=${formatTokens(call.cacheRead)} create=${formatTokens(call.cacheCreation)} uncached=${formatTokens(call.inputTokens)}
    </div>`

  if (call.responseText) {
    const rid = 'rsp-' + Math.random().toString(36).slice(2, 8)
    resHtml += `<div class="toggle-header" data-toggle-target="${rid}">
      <span class="toggle-indicator">[+]</span> Response text (${call.responseText.length} chars)
    </div>
    <div class="toggle-body collapsible-content" id="${rid}">${escapeHtml(call.responseText.slice(0, 2000))}</div>`
  }

  if (call.thinkingText) {
    const tid = 'thk-' + Math.random().toString(36).slice(2, 8)
    resHtml += `<div class="toggle-header" data-toggle-target="${tid}">
      <span class="toggle-indicator">[+]</span> Thinking
    </div>
    <div class="toggle-body collapsible-content collapsible-content--thinking" id="${tid}">${escapeHtml(call.thinkingText.slice(0, 1000))}</div>`
  }
  resHtml += '</div>'

  return `<tr class="call-detail-row" style="display:none;">
    <td colspan="9" style="padding:10px 14px;background:var(--bg-surface);border-bottom:1px solid var(--border);">
      <div style="display:flex;gap:24px;flex-wrap:wrap;">
        ${reqHtml}
        ${resHtml}
      </div>
    </td>
  </tr>`
}

export function renderRawCallsTab(container, calls) {
  if (!calls || calls.length === 0) {
    container.innerHTML = '<div style="color:#808080;margin-top:16px;">No raw calls</div>'
    return
  }

  const headers = ['#', 'Time', 'Model', 'Status', 'Latency', 'Input', 'Output', 'Cache', 'Msgs']

  let html = `<div class="mt-4" style="overflow-x:auto;font-size:13px;">
    <table class="table">
      <thead><tr>
        ${headers.map(h => `<th>${h}</th>`).join('')}
      </tr></thead>
      <tbody>`

  calls.forEach(call => {
    const badgeClass = modelBadgeClass(call.modelClass)
    html += `<tr class="call-summary-row">
      <td class="text-right tabular-nums" style="font-size:12px;">${call.index + 1}</td>
      <td style="font-size:12px;">${formatTime(call.timestamp)}</td>
      <td style="font-size:12px;"><span class="badge ${badgeClass}">${call.modelClass}</span></td>
      <td class="text-right tabular-nums" style="font-size:12px;">${call.statusCode || '-'}</td>
      <td class="text-right tabular-nums" style="font-size:12px;">${formatDuration(call.latency)}</td>
      <td class="text-right tabular-nums" style="font-size:12px;">${formatTokens(call.totalInput)}</td>
      <td class="text-right tabular-nums" style="font-size:12px;">${formatTokens(call.outputTokens)}</td>
      <td class="text-right tabular-nums" style="font-size:12px;${cacheColorClass(call.cacheHitRate)}">${(call.cacheHitRate ?? 0).toFixed(1)}%</td>
      <td class="text-right tabular-nums" style="font-size:12px;">${call.messageCount} msgs</td>
    </tr>`
    html += renderCallDetail(call)
  })

  html += '</tbody></table></div>'
  container.innerHTML = html

  // Wire expand/collapse on row click
  container.querySelectorAll('.call-summary-row').forEach(row => {
    row.addEventListener('click', () => {
      const detail = row.nextElementSibling
      if (detail && detail.classList.contains('call-detail-row')) {
        const visible = detail.style.display !== 'none'
        detail.style.display = visible ? 'none' : 'table-row'
      }
    })
  })

  // Wire collapsibles inside detail rows
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
