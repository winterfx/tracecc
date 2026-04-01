// API client — port of web/src/lib/api.ts

async function json(res) {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function fetchConfig() {
  return json(await fetch('/api/config'))
}

export async function startProxy(domain, bypass) {
  return json(await fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain, bypass }),
  }))
}

export async function stopProxy() {
  return json(await fetch('/api/stop', { method: 'POST' }))
}

export async function fetchLogFiles() {
  const data = await json(await fetch('/api/log-files'))
  return Array.isArray(data) ? data : []
}

export async function analyzeFiles(files) {
  return json(await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  }))
}

export async function fetchReportData(logFile) {
  return json(await fetch('/api/report-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logFile }),
  }))
}

export async function fetchReportDataMulti(files) {
  return json(await fetch('/api/report-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  }))
}

export async function browseDir(dir) {
  const params = dir ? '?dir=' + encodeURIComponent(dir) : ''
  return json(await fetch('/api/browse' + params))
}

export async function generateReport(logFile) {
  return json(await fetch('/api/generate-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logFile }),
  }))
}
