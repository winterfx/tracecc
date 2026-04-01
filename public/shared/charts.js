// Chart.js factory functions — VS Code dark theme

const COLORS = ['#569cd6', '#6a9955', '#c586c0', '#4ec9b0', '#dcdcaa', '#ce9178', '#9cdcfe', '#d4d4d4']

// Set Chart.js global defaults (call once after Chart.js loads)
export function initChartDefaults() {
  if (typeof Chart === 'undefined') return
  Chart.defaults.color = '#808080'
  Chart.defaults.borderColor = 'rgba(62, 62, 66, 0.6)'
  Chart.defaults.font.family = "'Cascadia Code','Fira Code','JetBrains Mono','Menlo',monospace"
  Chart.defaults.font.size = 10
}

// Destroy existing chart on a canvas before creating new one
function prepare(canvas) {
  const existing = Chart.getChart(canvas)
  if (existing) existing.destroy()
  return canvas.getContext('2d')
}

export function renderCostChart(canvas, costData) {
  const ctx = prepare(canvas)
  const labels = costData.byModel.map(m => m.model.replace('claude-', ''))
  const data = costData.byModel.map(m => m.totalCost)

  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Total Cost ($)',
        data,
        backgroundColor: COLORS.slice(0, labels.length),
        borderWidth: 0,
        borderRadius: 3,
      }],
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { callback: v => '$' + v.toFixed(4) } },
      },
    },
  })
}

export function renderTokenChart(canvas, tokenData) {
  const ctx = prepare(canvas)
  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Non-cache Input', 'Cache Creation', 'Cache Read', 'Output'],
      datasets: [{
        label: 'Tokens',
        data: [tokenData.nonCacheInput, tokenData.cacheCreation, tokenData.cacheRead, tokenData.totalOutput],
        backgroundColor: ['#569cd6', '#dcdcaa', '#4ec9b0', '#c586c0'],
        borderWidth: 0,
        borderRadius: 3,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        y: { ticks: { callback: v => (v / 1000).toFixed(0) + 'K' } },
      },
    },
  })
}

export function renderCacheChart(canvas, cacheData) {
  const ctx = prepare(canvas)
  const points = cacheData.perRequest || []
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(p => '#' + p.index),
      datasets: [{
        label: 'Cache Hit Rate (%)',
        data: points.map(p => p.hitRate),
        borderColor: '#569cd6',
        backgroundColor: 'rgba(86, 156, 214, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: points.length <= 50 ? 3 : 0,
        pointBackgroundColor: '#569cd6',
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        y: { min: 0, max: 100, ticks: { callback: v => v + '%' } },
      },
    },
  })
}

export function renderLatencyChart(canvas, latencyData) {
  const ctx = prepare(canvas)
  const models = latencyData.byModel || []
  const labels = models.map(m => m.model.replace('claude-', ''))

  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Avg', data: models.map(m => m.avg), backgroundColor: '#569cd6', borderRadius: 3 },
        { label: 'p50', data: models.map(m => m.p50), backgroundColor: '#6a9955', borderRadius: 3 },
        { label: 'p99', data: models.map(m => m.p99), backgroundColor: '#c586c0', borderRadius: 3 },
      ],
    },
    options: {
      plugins: { legend: { labels: { boxWidth: 10 } } },
      scales: {
        y: { ticks: { callback: v => v + 's' } },
      },
    },
  })
}

export function renderModelChart(canvas, modelData) {
  const ctx = prepare(canvas)
  return new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: modelData.map(m => m.model.replace('claude-', '')),
      datasets: [{
        data: modelData.map(m => m.requests),
        backgroundColor: COLORS.slice(0, modelData.length),
        borderColor: '#1e1e1e',
        borderWidth: 2,
      }],
    },
    options: {
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 10 } },
      },
    },
  })
}

export function renderTTFTChart(canvas, ttftData) {
  const ctx = prepare(canvas)
  const points = ttftData.perRequest || []
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(p => '#' + p.index),
      datasets: [{
        label: 'TTFT (s)',
        data: points.map(p => p.ttft),
        borderColor: '#4ec9b0',
        backgroundColor: 'rgba(78, 201, 176, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: points.length <= 50 ? 3 : 0,
        pointBackgroundColor: '#4ec9b0',
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        y: { min: 0, ticks: { callback: v => v.toFixed(1) + 's' } },
      },
    },
  })
}

export function renderContextChart(canvas, contextData) {
  const ctx = prepare(canvas)
  const pts = contextData.points || []

  // Gradient fill
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
  gradient.addColorStop(0, 'rgba(86, 156, 214, 0.3)')
  gradient.addColorStop(1, 'rgba(86, 156, 214, 0.02)')

  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: pts.map(p => '#' + p.index),
      datasets: [{
        label: 'Input Tokens',
        data: pts.map(p => p.totalInput),
        borderColor: '#569cd6',
        backgroundColor: gradient,
        fill: true,
        tension: 0.3,
        pointRadius: 2,
        pointBackgroundColor: '#569cd6',
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        y: { ticks: { callback: v => (v / 1000).toFixed(0) + 'K' } },
      },
    },
  })
}
