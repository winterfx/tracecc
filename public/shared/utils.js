// Shared utility functions

export function formatTokens(n) {
  if (!n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

export function formatSize(bytes) {
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB'
  return (bytes / 1024).toFixed(1) + ' KB'
}

export function formatDate(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleString()
}

export function formatTime(unixSec) {
  if (!unixSec) return '-'
  return new Date(unixSec * 1000).toLocaleTimeString()
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return '-'
  return (ms / 1000).toFixed(1) + 's'
}

export function escapeHtml(str) {
  if (!str) return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function simpleMarkdown(text) {
  if (!text) return ''
  let h = escapeHtml(text)
  h = h.replace(/```(\w*)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>')
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>')
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  h = h.replace(/^---$/gm, '<hr>')
  h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
  h = h.replace(/^- (.+)$/gm, '<li>$1</li>')
  h = h.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
  h = h.replace(/\n/g, '<br>')
  h = h.replace(/<br><h/g, '<h').replace(/<\/h(\d)><br>/g, '</h$1>')
  h = h.replace(/<br><pre>/g, '<pre>').replace(/<\/pre><br>/g, '</pre>')
  h = h.replace(/<br><ul>/g, '<ul>').replace(/<\/ul><br>/g, '</ul>')
  h = h.replace(/<br><hr>/g, '<hr>').replace(/<hr><br>/g, '<hr>')
  h = h.replace(/<br><blockquote>/g, '<blockquote>').replace(/<\/blockquote><br>/g, '</blockquote>')
  return h
}

export function getModelClass(model) {
  if (!model) return 'unknown'
  if (model.includes('opus')) return 'opus'
  if (model.includes('sonnet')) return 'sonnet'
  if (model.includes('haiku')) return 'haiku'
  return model
}

export function modelBadgeClass(modelClass) {
  const m = { opus: 'badge--opus', sonnet: 'badge--sonnet', haiku: 'badge--haiku' }
  return m[modelClass] || ''
}

export function toolIcon(category) {
  const icons = {
    'file-read': '\u{1F4C4}',
    'file-write': '\u270E',
    'command': '\u25B6',
    'agent': '\u{1F916}',
    'web': '\u{1F310}',
    'interaction': '\u{1F4AC}',
    'other': '\u2022',
  }
  return icons[category] || icons.other
}

export function toolNameClass(category) {
  const m = {
    'file-read': 'tool-name--file-read',
    'file-write': 'tool-name--file-write',
    'command': 'tool-name--command',
    'agent': 'tool-name--agent',
    'web': 'tool-name--web',
    'interaction': 'tool-name--interaction',
    'other': 'tool-name--other',
  }
  return m[category] || 'tool-name--other'
}

export function toolSummary(tool) {
  const inp = tool.input || {}
  switch (tool.name) {
    case 'Read': return inp.file_path ? String(inp.file_path).split('/').slice(-2).join('/') : ''
    case 'Grep': return inp.pattern ? `"${inp.pattern}"` : ''
    case 'Glob': return String(inp.pattern || '')
    case 'Bash': return String(inp.command || '').slice(0, 80)
    case 'Edit': return inp.file_path ? String(inp.file_path).split('/').slice(-2).join('/') : ''
    case 'Write': return inp.file_path ? String(inp.file_path).split('/').slice(-2).join('/') : ''
    case 'Agent': return String(inp.description || (inp.prompt ? String(inp.prompt).slice(0, 60) : ''))
    default: return tool.summary || ''
  }
}

export function cacheColorClass(rate) {
  if (rate >= 80) return 'color: var(--accent-green); font-weight: 600;'
  if (rate >= 40) return 'color: var(--accent-yellow);'
  return 'color: var(--accent-red);'
}

// Navigation HTML (shared across pages)
export function renderNav(activePage) {
  const links = [
    { href: '/', label: 'Proxy', id: 'proxy' },
    { href: '/analyze', label: 'Analyze', id: 'analyze' },
  ]
  return `
    <nav class="nav-header">
      <span class="nav-logo">TRACECC</span>
      <div class="nav-links">
        ${links.map(l =>
          `<a href="${l.href}" class="nav-link ${activePage === l.id ? 'nav-link--active' : ''}">${l.label}</a>`
        ).join('')}
      </div>
    </nav>
  `
}
