import fs from 'fs';
import path from 'path';

// Get command line arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node generate-html.js <input.jsonl> <output.html>');
  process.exit(1);
}

const inputFile = args[0];
const outputFile = args[1];

// Read JSONL file
const lines = fs.readFileSync(inputFile, 'utf-8').split('\n').filter(line => line.trim());
const logs = lines.map((line, index) => {
  try {
    const entry = JSON.parse(line);
    return { ...entry, index: index + 1 };
  } catch (e) {
    console.error(`Failed to parse line ${index + 1}:`, e.message);
    return null;
  }
}).filter(entry => entry !== null);

// Helper function to escape HTML and preserve formatting
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Helper function to format JSON with better readability
function formatJson(obj) {
  if (!obj) return '(empty)';
  const jsonStr = JSON.stringify(obj, null, 2);
  // Replace escaped newlines with actual newlines for better readability
  return jsonStr.replace(/\\n/g, '\n');
}

// Helper function to format response body
function formatResponseBody(body) {
  if (!body) {
    return '(empty)';
  }

  // Check if this is a SSE stream response
  if (body.stream_events && Array.isArray(body.stream_events)) {
    // Extract the actual message content from stream events
    let fullText = '';
    let metadata = {
      message_id: null,
      model: null,
      stop_reason: null,
      usage: null
    };

    for (const event of body.stream_events) {
      if (event.type === 'message_start' && event.message) {
        metadata.message_id = event.message.id;
        metadata.model = event.message.model;
        if (event.message.usage) {
          metadata.usage = event.message.usage;
        }
      } else if (event.type === 'content_block_delta' && event.delta?.text) {
        fullText += event.delta.text;
      } else if (event.type === 'message_delta' && event.delta) {
        metadata.stop_reason = event.delta.stop_reason;
        if (event.usage) {
          metadata.usage = { ...metadata.usage, ...event.usage };
        }
      }
    }

    // Format the output with better readability
    let formatted = '';

    // Main content section - most prominent
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    formatted += '📝 RESPONSE CONTENT\n';
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    formatted += fullText;
    formatted += '\n\n';

    // Metadata section - compact and organized
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    formatted += '📊 METADATA\n';
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    formatted += `Message ID    : ${metadata.message_id || 'N/A'}\n`;
    formatted += `Model         : ${metadata.model || 'N/A'}\n`;
    formatted += `Stop Reason   : ${metadata.stop_reason || 'N/A'}\n`;
    if (metadata.usage) {
      formatted += `Input Tokens  : ${metadata.usage.input_tokens || 0}\n`;
      if (metadata.usage.cache_creation_input_tokens) {
        formatted += `Cache Create  : ${metadata.usage.cache_creation_input_tokens}\n`;
      }
      if (metadata.usage.cache_read_input_tokens) {
        formatted += `Cache Read    : ${metadata.usage.cache_read_input_tokens}\n`;
      }
      formatted += `Output Tokens : ${metadata.usage.output_tokens || 0}\n`;
    }
    formatted += '\n';

    // Raw events section - collapsed at the end
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    formatted += `🔧 RAW EVENTS (${body.stream_events.length} events)\n`;
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    formatted += JSON.stringify(body.stream_events, null, 2);

    return formatted;
  }

  // Regular JSON response
  return formatJson(body);
}

// Generate HTML
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Proxy Logs - ${path.basename(inputFile)}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Courier New', 'Courier', monospace;
      background: #0a0a0a;
      background-image:
        repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255, 176, 0, 0.02) 2px, rgba(255, 176, 0, 0.02) 4px);
      padding: 20px;
      line-height: 1.6;
      color: #ffb000;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: #1a1a1a;
      border: 4px solid #ff8800;
      box-shadow:
        0 0 10px rgba(255, 136, 0, 0.3),
        inset 0 0 20px rgba(255, 136, 0, 0.08);
      image-rendering: pixelated;
    }

    header {
      background: #000000;
      border-bottom: 4px solid #ff8800;
      color: #ffb000;
      padding: 30px;
      text-align: center;
      text-shadow: 2px 2px 0px rgba(255, 176, 0, 0.3);
    }

    header h1 {
      font-size: 28px;
      margin-bottom: 10px;
      letter-spacing: 2px;
    }

    header p {
      color: #ff9900;
      font-size: 14px;
    }

    .summary {
      padding: 20px 30px;
      background: #000000;
      border-bottom: 4px solid #ff8800;
      display: flex;
      justify-content: space-around;
      flex-wrap: wrap;
      gap: 20px;
    }

    .summary-item {
      text-align: center;
      border: 2px solid #ff8800;
      padding: 10px 15px;
      background: #1a1a1a;
      box-shadow: 0 0 5px rgba(255, 136, 0, 0.25);
    }

    .summary-item .label {
      font-size: 12px;
      color: #ff9900;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 5px;
    }

    .summary-item .value {
      font-size: 24px;
      font-weight: bold;
      color: #ffb000;
      text-shadow: 0 0 5px rgba(255, 176, 0, 0.4);
    }

    .logs {
      padding: 20px;
      background: #0a0a0a;
    }

    .log-entry {
      margin-bottom: 20px;
      border: 3px solid #ff8800;
      overflow: hidden;
      transition: all 0.2s;
      background: #1a1a1a;
    }

    .log-entry:hover {
      box-shadow: 0 0 15px rgba(255, 136, 0, 0.4);
      border-color: #ff9900;
    }

    .log-header {
      background: #000000;
      padding: 15px 20px;
      cursor: pointer;
      user-select: none;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #ff8800;
    }

    .log-header:hover {
      background: #3a2000;
    }

    .log-title {
      display: flex;
      align-items: center;
      gap: 15px;
      flex: 1;
    }

    .log-index {
      background: #ff8800;
      color: #000000;
      padding: 4px 10px;
      border: 2px solid #ff8800;
      font-weight: bold;
      font-size: 12px;
    }

    .method {
      padding: 4px 8px;
      border: 2px solid;
      font-weight: bold;
      font-size: 12px;
      font-family: 'Courier New', monospace;
    }

    .method.POST { background: #331a00; color: #ffb000; border-color: #ff8800; }
    .method.GET { background: #331a00; color: #ffb000; border-color: #ff8800; }
    .method.PUT { background: #332200; color: #ffcc00; border-color: #ffcc00; }
    .method.DELETE { background: #330000; color: #ff0000; border-color: #ff0000; }
    .method.PATCH { background: #331a1a; color: #ffaa66; border-color: #ffaa66; }

    .status {
      padding: 4px 8px;
      border: 2px solid;
      font-weight: bold;
      font-size: 12px;
      font-family: 'Courier New', monospace;
    }

    .status.success { background: #331a00; color: #ffb000; border-color: #ff8800; }
    .status.redirect { background: #332200; color: #ffcc00; border-color: #ffcc00; }
    .status.client-error { background: #331a1a; color: #ff6666; border-color: #ff6666; }
    .status.server-error { background: #330000; color: #ff0000; border-color: #ff0000; }

    .url {
      font-family: 'Courier New', monospace;
      font-size: 13px;
      color: #ff9900;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .timestamp {
      font-size: 12px;
      color: #ff9900;
      font-family: 'Courier New', monospace;
    }

    .log-details {
      display: none;
      padding: 20px;
      background: #0a0a0a;
    }

    .log-details.active {
      display: block;
    }

    .section {
      margin-bottom: 20px;
      border: 2px solid #ff8800;
      overflow: hidden;
      background: #000000;
    }

    .section-title {
      font-weight: bold;
      color: #ffb000;
      padding: 10px 15px;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: #1a0f00;
      cursor: pointer;
      user-select: none;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #ff8800;
    }

    .section-title:hover {
      background: #2a1500;
    }

    .section-content {
      display: none;
    }

    .section-content.active {
      display: block;
    }

    .section-toggle {
      transition: transform 0.2s;
      font-size: 12px;
      color: #ffb000;
    }

    .section-toggle.active {
      transform: rotate(90deg);
    }

    .field-item {
      margin-bottom: 10px;
    }

    .field-header {
      cursor: pointer;
      user-select: none;
      padding: 8px 10px;
      background: #1a0a00;
      border: 2px solid #cc6600;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: bold;
      font-size: 12px;
      color: #ff9900;
    }

    .field-header:hover {
      background: #2a1500;
      box-shadow: 0 0 5px rgba(255, 136, 0, 0.3);
    }

    .field-header-static {
      padding: 8px 10px;
      background: #1a0a00;
      border: 2px solid #cc6600;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: bold;
      font-size: 12px;
      color: #ff9900;
    }

    .field-toggle {
      transition: transform 0.2s;
      font-size: 10px;
      color: #ff9900;
    }

    .field-toggle.active {
      transform: rotate(90deg);
    }

    .field-content {
      display: none;
      padding: 10px;
      background: #000000;
      border: 2px solid #cc6600;
      border-top: none;
    }

    .field-content.active {
      display: block;
    }

    .code-block {
      background: #0a0a0a;
      border: 2px solid #ff8800;
      padding: 15px;
      overflow-x: auto;
      font-family: 'Courier New', monospace;
      font-size: 13px;
      line-height: 1.5;
      color: #ffb000;
    }

    pre {
      margin: 0;
      white-space: pre-wrap;
      word-wrap: break-word;
      line-height: 1.6;
      color: #d4a574;
    }

    .toggle-icon {
      transition: transform 0.2s;
      color: #ff9900;
    }

    .toggle-icon.active {
      transform: rotate(90deg);
    }

    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }

    strong {
      color: #ffcc66;
      text-shadow: 0 0 3px rgba(255, 204, 102, 0.3);
    }

    @media (max-width: 768px) {
      .grid {
        grid-template-columns: 1fr;
      }

      .summary {
        flex-direction: column;
      }

      .log-title {
        flex-wrap: wrap;
      }
    }

    /* Pixel art scanline effect */
    @keyframes flicker {
      0% { opacity: 0.9; }
      50% { opacity: 1; }
      100% { opacity: 0.9; }
    }

    .container {
      animation: flicker 3s infinite;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🔍 Proxy Request/Response Logs</h1>
      <p>${path.basename(inputFile)} - Generated at ${new Date().toLocaleString()}</p>
    </header>

    <div class="summary">
      <div class="summary-item">
        <div class="label">Total Requests</div>
        <div class="value">${logs.length}</div>
      </div>
      <div class="summary-item">
        <div class="label">Success (2xx)</div>
        <div class="value">${logs.filter(l => l.response.status_code >= 200 && l.response.status_code < 300).length}</div>
      </div>
      <div class="summary-item">
        <div class="label">Redirects (3xx)</div>
        <div class="value">${logs.filter(l => l.response.status_code >= 300 && l.response.status_code < 400).length}</div>
      </div>
      <div class="summary-item">
        <div class="label">Client Errors (4xx)</div>
        <div class="value">${logs.filter(l => l.response.status_code >= 400 && l.response.status_code < 500).length}</div>
      </div>
      <div class="summary-item">
        <div class="label">Server Errors (5xx)</div>
        <div class="value">${logs.filter(l => l.response.status_code >= 500).length}</div>
      </div>
    </div>

    <div class="logs">
${logs.map(log => {
  const statusClass = log.response.status_code >= 200 && log.response.status_code < 300 ? 'success' :
                      log.response.status_code >= 300 && log.response.status_code < 400 ? 'redirect' :
                      log.response.status_code >= 400 && log.response.status_code < 500 ? 'client-error' :
                      'server-error';

  const reqTime = new Date(log.request.timestamp * 1000).toISOString();
  const respTime = new Date(log.response.timestamp * 1000).toISOString();

  return `      <div class="log-entry">
        <div class="log-header" onclick="toggleDetails(${log.index})">
          <div class="log-title">
            <span class="log-index">#${log.index}</span>
            <span class="method ${log.request.method}">${log.request.method}</span>
            <span class="status ${statusClass}">${log.response.status_code}</span>
            <span class="url" title="${log.request.url}">${log.request.url}</span>
          </div>
          <div>
            <span class="timestamp">${log.logged_at}</span>
            <span class="toggle-icon" id="icon-${log.index}">▶</span>
          </div>
        </div>
        <div class="log-details" id="details-${log.index}">
          <div class="grid">
            <div class="section">
              <div class="section-title" onclick="toggleSection(${log.index}, 'req')">
                <span>📤 Request</span>
                <span class="section-toggle" id="toggle-${log.index}-req">▶</span>
              </div>
              <div class="section-content" id="content-${log.index}-req">
                <div class="code-block">
                  <div><strong>Timestamp:</strong> ${reqTime}</div>
                  <div><strong>Method:</strong> ${log.request.method}</div>
                  <div><strong>URL:</strong> ${log.request.url}</div>

                  <div class="field-item">
                    <div class="field-header-static">
                      <span>Headers</span>
                    </div>
                    <div class="field-content active">
                      <pre>${formatJson(log.request.headers)}</pre>
                    </div>
                  </div>

                  <div class="field-item">
                    <div class="field-header" onclick="toggleField(${log.index}, 'req-body')">
                      <span>Body</span>
                      <span class="field-toggle" id="toggle-${log.index}-req-body">▶</span>
                    </div>
                    <div class="field-content" id="field-${log.index}-req-body">
                      <pre>${log.request.body ? formatJson(log.request.body) : '(empty)'}</pre>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="section">
              <div class="section-title" onclick="toggleSection(${log.index}, 'resp')">
                <span>📥 Response</span>
                <span class="section-toggle" id="toggle-${log.index}-resp">▶</span>
              </div>
              <div class="section-content" id="content-${log.index}-resp">
                <div class="code-block">
                  <div><strong>Timestamp:</strong> ${respTime}</div>
                  <div><strong>Status:</strong> ${log.response.status_code}</div>
                  <div><strong>Duration:</strong> ${((log.response.timestamp - log.request.timestamp) * 1000).toFixed(2)}ms</div>

                  <div class="field-item">
                    <div class="field-header-static">
                      <span>Headers</span>
                    </div>
                    <div class="field-content active">
                      <pre>${formatJson(log.response.headers)}</pre>
                    </div>
                  </div>

                  <div class="field-item">
                    <div class="field-header" onclick="toggleField(${log.index}, 'resp-body')">
                      <span>Body</span>
                      <span class="field-toggle" id="toggle-${log.index}-resp-body">▶</span>
                    </div>
                    <div class="field-content" id="field-${log.index}-resp-body">
                      <pre>${formatResponseBody(log.response.body)}</pre>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
}).join('\n')}
    </div>
  </div>

  <script>
    function toggleDetails(index) {
      const details = document.getElementById('details-' + index);
      const icon = document.getElementById('icon-' + index);
      details.classList.toggle('active');
      icon.classList.toggle('active');
    }

    function toggleSection(index, type) {
      const content = document.getElementById('content-' + index + '-' + type);
      const toggle = document.getElementById('toggle-' + index + '-' + type);
      content.classList.toggle('active');
      toggle.classList.toggle('active');
    }

    function toggleField(index, field) {
      const content = document.getElementById('field-' + index + '-' + field);
      const toggle = document.getElementById('toggle-' + index + '-' + field);
      content.classList.toggle('active');
      toggle.classList.toggle('active');
    }
  </script>
</body>
</html>`;

// Write HTML file
fs.writeFileSync(outputFile, html, 'utf-8');
console.log(`HTML log generated: ${outputFile}`);
