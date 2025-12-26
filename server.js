import http from 'http';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { config } from 'dotenv';
import os from 'os';

// Load environment variables from .env file
config();

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Claude settings file path
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// Store original ANTHROPIC_BASE_URL to restore later
let originalAnthropicBaseUrl = null;

// Update Claude settings to use local proxy
function updateClaudeSettings() {
  const proxyHost = `http://127.0.0.1:${PROXY_PORT}`;

  try {
    let settings = {};

    // Read existing settings if file exists
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
      settings = JSON.parse(content);
    } else {
      // Create directory if it doesn't exist
      const dir = path.dirname(CLAUDE_SETTINGS_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    // Ensure env object exists
    if (!settings.env) {
      settings.env = {};
    }

    // Save original URL for later restoration
    originalAnthropicBaseUrl = settings.env.ANTHROPIC_BASE_URL || null;

    // Update ANTHROPIC_BASE_URL - replace only the domain, keep the path
    let newUrl = proxyHost;
    if (settings.env.ANTHROPIC_BASE_URL) {
      try {
        const originalUrl = new URL(settings.env.ANTHROPIC_BASE_URL);
        // Combine proxy host with original path
        newUrl = proxyHost + originalUrl.pathname;
        // Preserve trailing slash if original had it
        if (settings.env.ANTHROPIC_BASE_URL.endsWith('/') && !newUrl.endsWith('/')) {
          newUrl += '/';
        }
      } catch (e) {
        // If parsing fails, just use proxy host
      }
    }
    settings.env.ANTHROPIC_BASE_URL = newUrl;

    // Write back to file
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log(`Updated Claude settings: ANTHROPIC_BASE_URL = ${newUrl}`);
  } catch (error) {
    console.error('Failed to update Claude settings:', error.message);
  }
}

// Restore original Claude settings
function restoreClaudeSettings() {
  if (originalAnthropicBaseUrl === null) {
    console.log('No original ANTHROPIC_BASE_URL to restore');
    return;
  }

  try {
    let settings = {};

    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
      settings = JSON.parse(content);
    }

    if (!settings.env) {
      settings.env = {};
    }

    settings.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;

    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log(`Restored Claude settings: ANTHROPIC_BASE_URL = ${originalAnthropicBaseUrl}`);

    originalAnthropicBaseUrl = null;
  } catch (error) {
    console.error('Failed to restore Claude settings:', error.message);
  }
}

// Open browser (cross-platform)
function openBrowser(url) {
  const platform = process.platform;
  let command;

  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      console.error('Failed to open browser:', error.message);
    } else {
      console.log(`Opened browser: ${url}`);
    }
  });
}

const WEB_PORT = 3001;
const PROXY_PORT = 8080;

// UI default values from environment
const UI_DEFAULTS = {
  domain: process.env.UI_DEFAULT_DOMAIN || '',
  bypassPaths: process.env.UI_DEFAULT_BYPASS_PATHS || ''
};

// Proxy state
let proxyServer = null;
let currentConfig = {
  target: '',
  bypassPaths: [],
  logFile: null
};

// Create a simple HTTP server for the web UI and API
const webServer = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API Routes
  if (req.url === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      defaults: UI_DEFAULTS
    }));
    return;
  }

  if (req.url === '/api/start' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { domain, bypass } = JSON.parse(body);

    if (proxyServer) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Proxy already running' }));
      return;
    }

    try {
      // Parse bypass paths
      const bypassPaths = bypass
        .split(',')
        .map(p => p.trim())
        .filter(p => p.length > 0);

      // Generate log file name
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const logFile = `log-${timestamp}.jsonl`;

      // Update config
      currentConfig.target = domain;
      currentConfig.bypassPaths = bypassPaths;
      currentConfig.logFile = logFile;

      // Update Claude settings to use proxy
      updateClaudeSettings();

      // Start proxy server
      startProxyServer();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        logFile: logFile
      }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  if (req.url === '/api/stop' && req.method === 'POST') {
    if (!proxyServer) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Proxy not running' }));
      return;
    }

    try {
      proxyServer.close();
      proxyServer = null;

      // Restore original Claude settings
      restoreClaudeSettings();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  if (req.url === '/api/generate-report' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { logFile } = JSON.parse(body);

    try {
      const htmlFile = logFile.replace('.jsonl', '.html');
      const command = `npx @mariozechner/claude-trace --generate-html ${logFile} ${htmlFile} --no-open`;

      console.log(`Executing: ${command}`);
      const { stdout, stderr } = await execAsync(command);

      if (stderr) {
        console.error('stderr:', stderr);
      }
      console.log('stdout:', stdout);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        htmlFile: htmlFile
      }));
    } catch (error) {
      console.error('Report generation error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  // Serve static files
  if (req.url === '/' || req.url === '/index.html') {
    serveFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html');
    return;
  }

  // Serve generated HTML reports and other files
  if (req.url.endsWith('.html')) {
    const filePath = path.join(__dirname, req.url.slice(1));
    serveFile(res, filePath, 'text/html');
    return;
  }

  if (req.url.endsWith('.css')) {
    const filePath = path.join(__dirname, 'public', req.url.slice(1));
    serveFile(res, filePath, 'text/css');
    return;
  }

  if (req.url.endsWith('.js')) {
    const filePath = path.join(__dirname, 'public', req.url.slice(1));
    serveFile(res, filePath, 'application/javascript');
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('File not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function startProxyServer() {
  proxyServer = http.createServer(async (req, res) => {
    try {
      const requestTimestamp = Date.now() / 1000;
      const targetUrl = new URL(req.url, currentConfig.target);

      // Check if this path should be bypassed
      const shouldBypass = currentConfig.bypassPaths.some(path => req.url.includes(path));

      // Read request body
      const reqChunks = [];
      for await (const chunk of req) reqChunks.push(chunk);
      const reqBody = Buffer.concat(reqChunks);

      // Parse request body if JSON
      let reqBodyObj = null;
      if (reqBody.length > 0) {
        try {
          reqBodyObj = JSON.parse(reqBody.toString('utf-8'));
        } catch (e) {
          // Not JSON, keep as null
        }
      }

      // Forward request to backend
      const fetchOptions = {
        method: req.method,
        headers: req.headers,
        body: reqBody.length ? reqBody : undefined,
        redirect: 'manual'
      };

      const upstreamResp = await fetch(targetUrl.toString(), fetchOptions);
      const responseTimestamp = Date.now() / 1000;
      const contentType = upstreamResp.headers.get('content-type') || '';
      const isSSE = contentType.includes('text/event-stream');

      // Write response headers
      upstreamResp.headers.forEach((v, k) => {
        if (!['transfer-encoding','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','upgrade'].includes(k.toLowerCase())) {
          res.setHeader(k, v);
        }
      });
      res.statusCode = upstreamResp.status;

      // Handle response body
      let respBodyObj = null;
      let respBodyRaw = null;
      let totalBytes = 0;

      if (isSSE && upstreamResp.body) {
        // Stream SSE response: forward chunks in real-time while caching for logging
        const chunks = [];
        const reader = upstreamResp.body.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Forward chunk to client immediately
            res.write(value);

            // Cache for logging
            chunks.push(value);
            totalBytes += value.length;
          }
        } finally {
          reader.releaseLock();
        }

        res.end();

        // Combine cached chunks for logging
        const respBuf = Buffer.concat(chunks);
        respBodyRaw = respBuf.toString('utf-8');

      } else {
        // Non-streaming response: read all at once
        const respBuf = Buffer.from(await upstreamResp.arrayBuffer());
        totalBytes = respBuf.length;
        res.end(respBuf);

        // Parse JSON if applicable
        if (respBuf.length > 0) {
          try {
            respBodyObj = JSON.parse(respBuf.toString('utf-8'));
          } catch (e) {
            // Not JSON, keep as null
          }
        }
      }

      // Console log
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} -> ${upstreamResp.status} (req ${reqBody.length}B, resp ${totalBytes}B) ${shouldBypass ? '[BYPASS]' : ''} ${isSSE ? '[SSE]' : ''}`);

      // Skip logging for bypassed paths
      if (!shouldBypass && currentConfig.logFile) {
        const logEntry = {
          request: {
            timestamp: requestTimestamp,
            method: req.method,
            url: targetUrl.toString(),
            headers: req.headers,
            body: reqBodyObj
          },
          response: {
            timestamp: responseTimestamp,
            status_code: upstreamResp.status,
            headers: Object.fromEntries(upstreamResp.headers.entries()),
            body: respBodyObj,
            body_raw: respBodyRaw
          },
          logged_at: new Date().toISOString()
        };

        // Append to JSONL file
        fs.appendFile(currentConfig.logFile, JSON.stringify(logEntry) + '\n', (err) => {
          if (err) {
            console.error('log write failed', err);
          }
        });
      }

    } catch (err) {
      console.error('proxy error', err);
      res.statusCode = 502;
      res.end('proxy error');
    }
  });

  proxyServer.listen(PROXY_PORT, () => {
    console.log(`Proxy started on http://0.0.0.0:${PROXY_PORT}, forwarding to ${currentConfig.target}`);
    console.log(`Bypass paths: ${currentConfig.bypassPaths.join(', ')}`);
    console.log(`Logging to: ${currentConfig.logFile}`);
  });
}

webServer.listen(WEB_PORT, () => {
  console.log(`Web UI running at http://localhost:${WEB_PORT}`);
  console.log(`Proxy will run on port ${PROXY_PORT} when started`);

  // Open browser automatically
  openBrowser(`http://localhost:${WEB_PORT}`);
});
