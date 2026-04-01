// RawCallInsightTab — port of RawCallInsightTab.tsx
import { getModelClass, modelBadgeClass, escapeHtml } from '../shared/utils.js'

export function renderRawInsightTab(container, entries) {
  if (!entries || entries.length === 0) {
    container.innerHTML = '<div style="color:#808080;margin-top:16px;">No raw entries</div>'
    return
  }

  let html = '<div class="mt-4" style="font-size:13px;">'

  entries.forEach((entry, i) => {
    const idx = entry.index ?? i
    const req = entry.request
    const res = entry.response
    const model = String(req?.body?.model || 'unknown')
    const method = req?.method || ''
    const ts = entry.logged_at || ''
    const msgCount = Array.isArray(req?.body?.messages) ? req.body.messages.length : 0
    const mc = getModelClass(model)
    const badgeClass = modelBadgeClass(mc)
    const cardId = 'insight-' + Math.random().toString(36).slice(2, 8)

    const rawLenNote = res?._body_raw_length
      ? ` (SSE body_raw: ${Number(res._body_raw_length).toLocaleString()} chars, omitted)`
      : ''

    html += `<div class="insight-card">
      <div class="conv-header" data-insight-toggle="${cardId}">
        <div class="conv-header-left" style="font-size:12px;">
          <span class="toggle-indicator">[+]</span>
          <span style="color:var(--accent-teal);font-weight:600;">#${idx + 1}</span>
          <span style="margin-left:8px;">${escapeHtml(method)}</span>
          <span class="badge ${badgeClass}" style="margin-left:8px;">${escapeHtml(model)}</span>
          <span style="color:#808080;margin-left:8px;">${msgCount} msgs</span>
        </div>
        <div class="conv-header-right">${escapeHtml(ts)}</div>
      </div>
      <div class="insight-body" id="${cardId}" style="display:none;">
        <div class="insight-pane">
          <div style="color:var(--accent-green);font-weight:600;font-size:11px;text-transform:uppercase;margin-bottom:6px;">Request</div>
          <pre>${escapeHtml(JSON.stringify(req, null, 2))}</pre>
        </div>
        <div class="insight-pane">
          <div style="color:var(--accent-blue);font-weight:600;font-size:11px;text-transform:uppercase;margin-bottom:6px;">Response${escapeHtml(rawLenNote)}</div>
          <pre>${escapeHtml(JSON.stringify(res, null, 2))}</pre>
        </div>
      </div>
    </div>`
  })

  html += '</div>'
  container.innerHTML = html

  // Wire up insight card expand/collapse
  container.querySelectorAll('[data-insight-toggle]').forEach(header => {
    header.addEventListener('click', () => {
      const targetId = header.dataset.insightToggle
      const body = document.getElementById(targetId)
      const ind = header.querySelector('.toggle-indicator')
      if (body.style.display === 'none') {
        body.style.display = 'flex'
        if (ind) ind.textContent = '[-]'
      } else {
        body.style.display = 'none'
        if (ind) ind.textContent = '[+]'
      }
    })
  })
}
