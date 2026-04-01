// SimulatorTab — port of SimulatorTab.tsx + useSimulator.ts + SwimLaneChart.tsx + MessageRow.tsx + constants.ts
import { formatTokens, escapeHtml } from '../shared/utils.js'

// ── Constants (from constants.ts) ──────────────────────────────────────────────

const LANES = ['user', 'agents', 'llm', 'tools']
const LANE_META = {
  user:   { label: 'User',   color: '#6a9955' },
  agents: { label: 'Agents', color: '#c586c0' },
  llm:    { label: 'LLM',    color: '#569cd6' },
  tools:  { label: 'Tools',  color: '#dcdcaa' },
}
const LANE_CENTER_PCT = { user: 12.5, agents: 37.5, llm: 62.5, tools: 87.5 }

function isDashed(type) { return type === 'call' || type === 'result' }

function getMessageColor(from, to, type) {
  if (type === 'thinking') return LANE_META.llm.color
  if (type === 'request' && from === 'user') return LANE_META.user.color
  if (type === 'request' && from === 'agents') return LANE_META.agents.color
  if (type === 'response' && to === 'user') return LANE_META.agents.color
  if (type === 'response' && to === 'agents') return LANE_META.llm.color
  if (to === 'tools' || from === 'tools') return LANE_META.tools.color
  if (to === 'agents' || from === 'agents') return LANE_META.agents.color
  return LANE_META.llm.color
}

// ── buildUnifiedMessages (from useSimulator.ts) ────────────────────────────────

function buildUnifiedMessages(conv) {
  const msgs = []
  let globalStep = 0

  function addConvMessages(c, depth) {
    for (let si = 0; si < c.steps.length; si++) {
      const step = c.steps[si]
      const curGlobal = globalStep++

      // User sends request to Agent
      if (si === 0) {
        msgs.push({
          from: 'user', to: 'agents', type: 'request', stepIndex: curGlobal,
          label: c.firstUserText.slice(0, 80),
          detail: '', depth,
          convLabel: depth === 0 ? '' : c.modelClass,
          meta: { tokens: step.totalInput, cache: step.cacheHitRate },
        })
        // Agent forwards to LLM
        msgs.push({
          from: 'agents', to: 'llm', type: 'request', stepIndex: curGlobal,
          label: c.firstUserText.slice(0, 80),
          detail: '', depth,
          convLabel: depth === 0 ? '' : c.modelClass,
          meta: { tokens: step.totalInput, cache: step.cacheHitRate },
        })
      }

      // Tool results: Tools → Agents → LLM (agent forwards results to LLM)
      if (si > 0 && step.newToolResults && step.newToolResults.length > 0) {
        msgs.push({
          from: 'tools', to: 'agents', type: 'result',
          stepIndex: curGlobal,
          label: step.newToolResults.length + ' result(s)',
          detail: step.newToolResults.map(r => (r.isError ? '[ERR] ' : '') + (r.content || '').slice(0, 80)).join('\n'),
          depth,
          convLabel: depth === 0 ? '' : c.modelClass,
          meta: { tokens: step.totalInput, cache: step.cacheHitRate },
        })
        // Agent forwards results to LLM in next request
        msgs.push({
          from: 'agents', to: 'llm', type: 'request',
          stepIndex: curGlobal,
          label: step.newToolResults.length + ' result(s)',
          detail: '',
          depth,
          convLabel: depth === 0 ? '' : c.modelClass,
          meta: { tokens: step.totalInput, cache: step.cacheHitRate },
        })
      }

      // LLM thinking
      const stepModel = step.model || c.model || ''
      if (step.thinkingText) {
        msgs.push({
          from: 'llm', to: 'llm', type: 'thinking', stepIndex: curGlobal,
          label: 'thinking...', detail: step.thinkingText.slice(0, 300),
          depth, convLabel: depth === 0 ? '' : c.modelClass,
          meta: { model: stepModel },
        })
      }

      // LLM response with tool_use: LLM → Agents (response), then Agents → Tools (call)
      if (step.newToolCalls && step.newToolCalls.length > 0) {
        const agentCalls = step.newToolCalls.filter(t => t.category === 'agent')
        const toolCalls = step.newToolCalls.filter(t => t.category !== 'agent')

        // LLM responds to Agent with tool_use instructions
        const allCallLabels = step.newToolCalls.map(t => t.name + ': ' + t.summary.slice(0, 40))
        msgs.push({
          from: 'llm', to: 'agents', type: 'response', stepIndex: curGlobal,
          label: allCallLabels.join('\n'),
          detail: '', depth, convLabel: '',
          meta: { outputTokens: step.outputTokens, model: stepModel },
        })

        // Agent executes tool calls: Agents → Tools
        if (toolCalls.length > 0) {
          msgs.push({
            from: 'agents', to: 'tools', type: 'call', stepIndex: curGlobal,
            label: toolCalls.map(t => t.name + ': ' + t.summary.slice(0, 40)).join('\n'),
            detail: '', depth, convLabel: '',
          })
        }

        // Agent spawns sub-agents: Agents → Agents (sub-agent)
        if (agentCalls.length > 0) {
          msgs.push({
            from: 'agents', to: 'agents', type: 'call', stepIndex: curGlobal,
            label: agentCalls.map(t => 'Agent: ' + t.summary.slice(0, 50)).join('\n'),
            detail: '', depth, convLabel: '',
          })

          for (const ac of agentCalls) {
            const subName = (ac.summary || '').slice(0, 60)
            const matchedSub = (conv.subAgents || []).find(
              sa => sa.firstUserText && subName && sa.firstUserText.startsWith(subName.slice(0, 30))
            )
            if (matchedSub) addConvMessages(matchedSub, depth + 1)
          }

          // Sub-agent results return to Agent
          msgs.push({
            from: 'agents', to: 'agents', type: 'result', stepIndex: curGlobal,
            label: agentCalls.length + ' agent result(s)',
            detail: '', depth, convLabel: '',
          })
        }
      }

      // Final response (no tool calls): LLM → Agent → User
      if (step.responseText && (!step.newToolCalls || step.newToolCalls.length === 0)) {
        const stepModel = step.model || c.model || ''
        msgs.push({
          from: 'llm', to: 'agents', type: 'response', stepIndex: curGlobal,
          label: step.responseText.slice(0, 100), detail: step.responseText,
          depth, convLabel: '',
          meta: { outputTokens: step.outputTokens, model: stepModel },
        })
        msgs.push({
          from: 'agents', to: 'user', type: 'response', stepIndex: curGlobal,
          label: step.responseText.slice(0, 100), detail: step.responseText,
          depth, convLabel: '',
          meta: { outputTokens: step.outputTokens },
        })
      }
    }
  }

  addConvMessages(conv, 0)
  return msgs
}

// ── SimulatorEngine ────────────────────────────────────────────────────────────

class SimulatorEngine {
  constructor(conv) {
    this.messages = conv ? buildUnifiedMessages(conv) : []
    this.currentStep = -1
    this.playing = false
    this._intervalId = null
    this._onChange = null
  }

  get totalSteps() { return this.messages.length }

  onChange(fn) { this._onChange = fn }

  _notify() { if (this._onChange) this._onChange(this.currentStep, this.playing) }

  _clearTimer() {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId)
      this._intervalId = null
    }
  }

  play() {
    this.playing = true
    if (this.currentStep >= this.totalSteps - 1) this.currentStep = 0
    else if (this.currentStep < 0) this.currentStep = 0
    this._notify()

    this._clearTimer()
    this._intervalId = setInterval(() => {
      if (this.currentStep >= this.totalSteps - 1) {
        this.playing = false
        this._clearTimer()
        this._notify()
        return
      }
      this.currentStep++
      this._notify()
    }, 1500)
  }

  pause() {
    this.playing = false
    this._clearTimer()
    this._notify()
  }

  step() {
    this.playing = false
    this._clearTimer()
    if (this.currentStep < this.totalSteps - 1) this.currentStep++
    this._notify()
  }

  reset() {
    this.playing = false
    this._clearTimer()
    this.currentStep = -1
    this._notify()
  }

  destroy() { this._clearTimer() }
}

// ── Render helpers ─────────────────────────────────────────────────────────────

function renderTokenBadge(meta) {
  if (!meta) return ''
  const parts = []
  if (meta.tokens != null) parts.push(formatTokens(meta.tokens) + ' in')
  if (meta.outputTokens != null) parts.push(formatTokens(meta.outputTokens) + ' out')
  let html = ''
  if (meta.model) {
    html += `<span class="swim-model-badge">${escapeHtml(meta.model)}</span>`
  }
  if (parts.length > 0) {
    html += `<span class="swim-token-badge">${parts.join(' / ')}</span>`
  }
  return html
}

function renderArrowSvg(from, to, color, dashed) {
  const x1 = LANE_CENTER_PCT[from]
  const x2 = LANE_CENTER_PCT[to]
  const pointsRight = x2 > x1
  const tipX = x2
  const baseX = pointsRight ? x2 - 1.2 : x2 + 1.2
  const arrowPoints = `${tipX},50 ${baseX},30 ${baseX},70`
  const dashAttr = dashed ? 'stroke-dasharray="4 3"' : ''

  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none"
    style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;">
    <line x1="${x1}" y1="50" x2="${pointsRight ? x2 - 1 : x2 + 1}" y2="50"
      stroke="${color}" stroke-width="1.5" ${dashAttr} vector-effect="non-scaling-stroke"/>
    <polygon points="${arrowPoints}" fill="${color}"/>
  </svg>`
}

// Brain SVG icon (replaces lucide-react Brain)
const BRAIN_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg>`

function renderMessageRow(msg, idx) {
  const from = msg.from
  const to = msg.to
  const color = getMessageColor(from, to, msg.type)
  const isThinking = msg.type === 'thinking'
  const depthMargin = msg.depth > 0 ? msg.depth * 16 : 0

  // Self-referencing messages (thinking, agent→agent) render as centered cards
  const isSelfRef = from === to
  if (isThinking || isSelfRef) {
    const laneCenter = LANE_CENTER_PCT[from]
    const icon = isThinking ? BRAIN_SVG : ''
    const typeLabel = isThinking ? 'thinking' : msg.type
    return `<div class="swim-msg-row" data-idx="${idx}"
      style="min-height:56px;opacity:0.15;margin-left:${depthMargin}px;">
      <div class="swim-msg-card" style="left:calc(${laneCenter}% - 110px + ${depthMargin}px);width:220px;top:6px;
        border-left:3px solid ${color};display:flex;align-items:flex-start;gap:6px;">
        ${icon ? `<span style="color:${color};flex-shrink:0;margin-top:1px;">${icon}</span>` : ''}
        <div style="min-width:0;">
          <span class="swim-type-badge" style="color:${color};">${escapeHtml(typeLabel)}</span>
          ${renderTokenBadge(msg.meta)}
          <span style="font-style:italic;color:#a0a0a0;">${escapeHtml(msg.label)}</span>
        </div>
      </div>
    </div>`
  }

  // Arrow message
  const midPct = (LANE_CENTER_PCT[from] + LANE_CENTER_PCT[to]) / 2
  const cardWidth = 200

  let subLabel = ''
  if (msg.depth > 0 && msg.convLabel) {
    subLabel = `<div style="font-size:9px;color:var(--accent-purple);margin-top:2px;">sub-agent L${msg.depth}: ${escapeHtml(msg.convLabel)}</div>`
  }

  return `<div class="swim-msg-row" data-idx="${idx}"
    style="min-height:52px;opacity:0.15;margin-left:${depthMargin}px;">
    <div style="position:absolute;inset:0;height:52px;">
      ${renderArrowSvg(from, to, color, isDashed(msg.type))}
    </div>
    <div class="swim-msg-card" style="left:calc(${midPct}% - ${cardWidth / 2}px + ${depthMargin / 2}px);top:8px;width:${cardWidth}px;">
      <div style="display:flex;align-items:center;">
        <span class="swim-type-badge" style="color:${color};">${escapeHtml(msg.type)}</span>
        ${renderTokenBadge(msg.meta)}
      </div>
      <div class="truncate" style="font-size:11px;line-height:1.3;margin-top:2px;">${escapeHtml(msg.label)}</div>
      ${subLabel}
    </div>
  </div>`
}

function renderDetailPanel(msg, color) {
  let metaHtml = `<span style="text-transform:uppercase;font-weight:600;color:${color};">${msg.from} \u2192 ${msg.to}</span>`
  if (msg.meta?.model) metaHtml += `<span style="color:#569cd6;">Model: ${msg.meta.model}</span>`
  if (msg.meta?.tokens != null) metaHtml += `<span>Input: ${msg.meta.tokens.toLocaleString()} tokens</span>`
  if (msg.meta?.cache != null) metaHtml += `<span>Cache: ${msg.meta.cache.toFixed(0)}%</span>`
  if (msg.meta?.outputTokens != null) metaHtml += `<span>Output: ${msg.meta.outputTokens.toLocaleString()} tokens</span>`

  return `<div class="swim-detail-panel" style="border-color:${color}40;border-left:3px solid ${color};">
    <div style="display:flex;align-items:center;gap:12px;font-size:10px;color:#808080;margin-bottom:8px;">
      ${metaHtml}
    </div>
    <div style="white-space:pre-wrap;word-break:break-word;line-height:1.6;max-height:200px;overflow-y:auto;font-size:11px;">
      ${escapeHtml(msg.detail || msg.label)}
    </div>
  </div>`
}

// ── Main export ────────────────────────────────────────────────────────────────

export function renderSimulatorTab(container, conversations) {
  const simConvs = (conversations || []).filter(c => c.steps && c.steps.length > 1)

  if (simConvs.length === 0) {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:256px;color:#808080;font-size:13px;">No multi-step conversations to simulate.</div>'
    return
  }

  let engine = null
  let convIndex = 0
  let expandedIdx = null

  function buildUI() {
    const conv = simConvs[convIndex]
    if (engine) engine.destroy()
    engine = new SimulatorEngine(conv)
    expandedIdx = null

    // Conversation selector options
    const options = simConvs.map((c, i) =>
      `<option value="${i}">${c.isMainThread ? '[Main] ' : '[Sub] '}${escapeHtml(c.firstUserText.slice(0, 60))} (${c.steps.length} steps)</option>`
    ).join('')

    container.innerHTML = `
      <div style="font-size:13px;">
        <!-- Controls -->
        <div class="sim-controls">
          <select class="select" id="sim-conv-select" style="max-width:400px;">${options}</select>
          <button class="btn btn--primary btn--sm" id="sim-play-btn">\u25B6 Play</button>
          <button class="btn btn--sm" id="sim-step-btn">Step \u2192</button>
          <button class="btn btn--sm" id="sim-reset-btn">Reset</button>
          <span id="sim-step-label" style="color:#808080;font-size:12px;font-variant-numeric:tabular-nums;">Ready</span>
        </div>

        <!-- Context meter -->
        <div class="ctx-meter">
          <span style="color:#808080;">Context:</span>
          <div class="ctx-meter-bar"><div class="ctx-meter-fill" id="sim-ctx-fill" style="width:0%"></div></div>
          <span id="sim-ctx-label" style="color:#808080;min-width:100px;text-align:right;font-variant-numeric:tabular-nums;">---</span>
        </div>

        <!-- Legend -->
        <div class="sim-legend">
          ${LANES.map(lane => `<div class="sim-legend-item">
            <div class="sim-legend-dot" style="background:${LANE_META[lane].color};"></div>
            <span class="sim-legend-label">${LANE_META[lane].label}</span>
          </div>`).join('')}
        </div>

        <!-- Swim Lane Chart -->
        <div style="border:1px solid var(--border);overflow:hidden;height:500px;">
          <div class="swim-lane">
            <div class="swim-lane-header">
              ${LANES.map(lane => `<div class="swim-lane-header-cell">
                <div class="swim-lane-dot" style="background:${LANE_META[lane].color};"></div>
                <span class="swim-lane-label" style="color:${LANE_META[lane].color};">${LANE_META[lane].label}</span>
              </div>`).join('')}
            </div>
            <div class="swim-lane-body" id="sim-body">
              ${LANES.map(lane => `<div class="swim-lane-lifeline" style="left:${LANE_CENTER_PCT[lane]}%;border-left:1px dashed ${LANE_META[lane].color}25;"></div>`).join('')}
              <div class="swim-lane-rows" id="sim-rows">
                ${engine.messages.map((msg, idx) => renderMessageRow(msg, idx)).join('')}
              </div>
            </div>
          </div>
        </div>
      </div>
    `

    // Wire events
    const selectEl = container.querySelector('#sim-conv-select')
    selectEl.value = convIndex
    selectEl.addEventListener('change', e => {
      convIndex = Number(e.target.value)
      buildUI()
    })

    container.querySelector('#sim-play-btn').addEventListener('click', () => {
      engine.playing ? engine.pause() : engine.play()
    })
    container.querySelector('#sim-step-btn').addEventListener('click', () => engine.step())
    container.querySelector('#sim-reset-btn').addEventListener('click', () => engine.reset())

    // Wire row clicks
    container.querySelectorAll('.swim-msg-row').forEach(row => {
      row.addEventListener('click', () => {
        const idx = Number(row.dataset.idx)
        if (idx > engine.currentStep) return
        if (expandedIdx === idx) {
          expandedIdx = null
        } else {
          expandedIdx = idx
        }
        updateRows()
      })
    })

    engine.onChange((step, playing) => {
      updateControls(step, playing)
      updateRows()
    })
  }

  function updateControls(step, playing) {
    const playBtn = container.querySelector('#sim-play-btn')
    const stepBtn = container.querySelector('#sim-step-btn')
    const stepLabel = container.querySelector('#sim-step-label')
    const ctxFill = container.querySelector('#sim-ctx-fill')
    const ctxLabel = container.querySelector('#sim-ctx-label')

    if (playBtn) {
      playBtn.textContent = playing ? '\u23F8 Pause' : '\u25B6 Play'
      playBtn.className = playing ? 'btn btn--destructive btn--sm' : 'btn btn--primary btn--sm'
    }
    if (stepBtn) stepBtn.disabled = step >= engine.totalSteps - 1
    if (stepLabel) stepLabel.textContent = step < 0 ? 'Ready' : `Step ${step + 1} / ${engine.totalSteps}`

    // Context meter
    const conv = simConvs[convIndex]
    if (conv && step >= 0) {
      const maxCtx = Math.max(...conv.steps.map(s => s.totalInput), 1)
      const curStep = conv.steps[step]
      const ctxPct = curStep ? (curStep.totalInput / maxCtx) * 100 : 0
      const ctxTokens = curStep?.totalInput || 0
      if (ctxFill) ctxFill.style.width = ctxPct + '%'
      if (ctxLabel) ctxLabel.textContent = ctxTokens > 0 ? formatTokens(ctxTokens) + ' tokens' : '---'
    } else {
      if (ctxFill) ctxFill.style.width = '0%'
      if (ctxLabel) ctxLabel.textContent = '---'
    }
  }

  function updateRows() {
    const rows = container.querySelectorAll('.swim-msg-row')
    const step = engine.currentStep

    // Remove old detail panels
    container.querySelectorAll('.swim-detail-panel').forEach(p => p.remove())

    rows.forEach(row => {
      const idx = Number(row.dataset.idx)
      const visible = idx <= step
      const isCurrent = idx === step
      const msg = engine.messages[idx]
      const color = getMessageColor(msg.from, msg.to, msg.type)

      row.style.opacity = visible ? '1' : '0.15'

      // Update card styles
      const card = row.querySelector('.swim-msg-card')
      if (card) {
        card.style.background = isCurrent ? color + '18' : '#252526e0'
        card.style.borderColor = isCurrent ? color : 'var(--border)'
        card.style.boxShadow = isCurrent ? `0 0 10px ${color}30` : 'none'
      }

      // Show expanded detail
      if (idx === expandedIdx && visible) {
        const panel = document.createElement('div')
        panel.innerHTML = renderDetailPanel(msg, color)
        row.appendChild(panel.firstElementChild)
      }

      // Auto-scroll to current step
      if (isCurrent) {
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    })
  }

  buildUI()
}
