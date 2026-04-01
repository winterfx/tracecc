import http from 'http';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { config } from 'dotenv';
import os from 'os';
import { parseLogFiles, computeAnalysis } from './analyze-lib.js';
import { parseJSONL, buildRawCalls, buildConversations, buildRawEntries } from './generate-report.js';

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
      const command = `node generate-report.js ${logFile} ${htmlFile}`;

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

  // ─── Analyze API Routes ────────────────────────────────────────────────────

  // ─── Browse directories for .jsonl files ───────────────────────────────────

  if (req.url.startsWith('/api/browse') && req.method === 'GET') {
    try {
      const reqUrl = new URL(req.url, `http://${req.headers.host}`);
      let dir = reqUrl.searchParams.get('dir');

      // Default to ~/.claude/projects
      if (!dir) {
        dir = path.join(os.homedir(), '.claude', 'projects');
      }

      // Resolve to absolute path
      const resolvedDir = path.resolve(dir);

      // Restrict browsing to ~/.claude/ to prevent arbitrary filesystem traversal
      const allowedRoot = path.join(os.homedir(), '.claude');
      if (!resolvedDir.startsWith(allowedRoot + path.sep) && resolvedDir !== allowedRoot) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Access denied: browsing is restricted to ~/.claude/' }));
        return;
      }

      if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: resolvedDir, parent: path.dirname(resolvedDir), entries: [], error: 'Directory not found' }));
        return;
      }

      const items = fs.readdirSync(resolvedDir);
      const entries = [];

      for (const name of items) {
        if (name.startsWith('.') && name !== '.claude') continue; // skip hidden files except .claude
        const fullPath = path.join(resolvedDir, name);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            // Count .jsonl files recursively (shallow — just check immediate children)
            let jsonlCount = 0;
            try {
              jsonlCount = fs.readdirSync(fullPath).filter(f => f.endsWith('.jsonl')).length;
            } catch { /* ignore permission errors */ }
            entries.push({ name, type: 'dir', path: fullPath, jsonlCount });
          } else if (name.endsWith('.jsonl')) {
            entries.push({
              name, type: 'file', path: fullPath,
              size: stat.size,
              modified: stat.mtime.toISOString(),
            });
          }
        } catch { /* skip unreadable entries */ }
      }

      // Sort: directories first (alphabetical), then files (newest first)
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        if (a.type === 'dir') return a.name.localeCompare(b.name);
        return new Date(b.modified) - new Date(a.modified);
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        path: resolvedDir,
        parent: path.dirname(resolvedDir) !== resolvedDir && path.dirname(resolvedDir).startsWith(allowedRoot) ? path.dirname(resolvedDir) : null,
        entries,
      }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.url === '/api/log-files' && req.method === 'GET') {
    try {
      const logFiles = fs.readdirSync(__dirname)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const stat = fs.statSync(path.join(__dirname, f));
          return {
            name: f,
            size: stat.size,
            modified: stat.mtime.toISOString(),
          };
        })
        .sort((a, b) => new Date(b.modified) - new Date(a.modified));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(logFiles));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (req.url === '/api/analyze' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { files: fileNames } = JSON.parse(body);

      if (!Array.isArray(fileNames) || fileNames.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No files specified' }));
        return;
      }

      // Resolve file paths — support both absolute paths and local filenames
      const allowedRoot = path.join(os.homedir(), '.claude');
      const filePaths = fileNames.map(f => {
        if (path.isAbsolute(f)) {
          const resolved = path.resolve(f);
          if (!resolved.startsWith(allowedRoot + path.sep) && !resolved.startsWith(__dirname + path.sep)) {
            throw new Error(`Access denied: ${f}`);
          }
          return resolved;
        }
        // Legacy: local filenames (no path separators)
        if (f.includes('/') || f.includes('\\') || f.includes('..') || !f.endsWith('.jsonl')) {
          throw new Error(`Invalid filename: ${f}`);
        }
        return path.join(__dirname, f);
      });

      // Validate all files exist and are .jsonl
      for (const fp of filePaths) {
        if (!fp.endsWith('.jsonl')) throw new Error(`Not a .jsonl file: ${fp}`);
        if (!fs.existsSync(fp)) throw new Error(`File not found: ${fp}`);
      }

      const displayNames = filePaths.map(f => path.basename(f));
      const records = parseLogFiles(filePaths);

      if (records.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No valid log entries found in selected files' }));
        return;
      }

      const result = computeAnalysis(records, displayNames);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ─── Report Data API (for React frontend) ──────────────────────────────────

  if (req.url === '/api/report-data' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { logFile, files } = JSON.parse(body);

      // Determine file list: accept { files: string[] } or { logFile: string }
      const fileNames = Array.isArray(files) && files.length > 0
        ? files
        : logFile ? [logFile] : [];

      if (fileNames.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No files specified' }));
        return;
      }

      // Resolve file paths — support both absolute paths and local filenames
      const allowedRoot = path.join(os.homedir(), '.claude');
      const filePaths = fileNames.map(f => {
        if (path.isAbsolute(f)) {
          const resolved = path.resolve(f);
          if (!resolved.startsWith(allowedRoot + path.sep) && !resolved.startsWith(__dirname + path.sep)) {
            throw new Error(`Access denied: ${f}`);
          }
          return resolved;
        }
        if (f.includes('/') || f.includes('\\') || f.includes('..') || !f.endsWith('.jsonl')) {
          throw new Error(`Invalid filename: ${f}`);
        }
        return path.join(__dirname, f);
      });

      for (const fp of filePaths) {
        if (!fp.endsWith('.jsonl')) throw new Error(`Not a .jsonl file: ${fp}`);
        if (!fs.existsSync(fp)) throw new Error(`File not found: ${fp}`);
      }

      // Parse all files into a single entries array
      let allEntries = [];
      for (const fp of filePaths) {
        const entries = parseJSONL(fp);
        allEntries = allEntries.concat(entries);
      }

      // Sort by request timestamp for correct chronological ordering across files
      if (fileNames.length > 1) {
        allEntries.sort((a, b) => (a.request?.timestamp || 0) - (b.request?.timestamp || 0));
      }

      const rawCalls = buildRawCalls(allEntries);
      const conversations = buildConversations(allEntries);
      const rawEntries = buildRawEntries(allEntries);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        rawCalls,
        conversations,
        rawEntries,
        inputFile: filePaths.length === 1 ? path.basename(filePaths[0]) : filePaths.map(f => path.basename(f)).join(', '),
      }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // ─── Static files (vanilla HTML/CSS/JS frontend) ───────────────────────────

  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  // HTML pages
  if (req.url === '/' || req.url === '/index.html') {
    serveFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html');
    return;
  }

  if (req.url === '/analyze' || req.url === '/analyze.html') {
    serveFile(res, path.join(__dirname, 'public', 'analyze.html'), 'text/html');
    return;
  }

  if (req.url.startsWith('/report/') || req.url === '/report') {
    serveFile(res, path.join(__dirname, 'public', 'report.html'), 'text/html');
    return;
  }

  // Shared assets and component JS modules
  if (req.url.startsWith('/shared/') || req.url.startsWith('/components/')) {
    const filePath = path.join(__dirname, 'public', req.url.split('?')[0]);
    const ext = path.extname(filePath);
    serveFile(res, filePath, mimeTypes[ext] || 'application/octet-stream');
    return;
  }

  // Generated HTML reports (e.g. log-xxx.html in root dir)
  if (req.url.endsWith('.html')) {
    const filePath = path.join(__dirname, req.url.slice(1));
    serveFile(res, filePath, 'text/html');
    return;
  }

  // Other static assets in public/
  if (req.url.endsWith('.css') || req.url.endsWith('.js')) {
    const filePath = path.join(__dirname, 'public', req.url.slice(1));
    const ext = path.extname(filePath);
    serveFile(res, filePath, mimeTypes[ext] || 'application/octet-stream');
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
      let firstChunkTimestamp = null;

      if (isSSE && upstreamResp.body) {
        // Stream SSE response: forward chunks in real-time while caching for logging
        const chunks = [];
        const reader = upstreamResp.body.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Record TTFT: timestamp of first data chunk
            if (!firstChunkTimestamp) {
              firstChunkTimestamp = Date.now() / 1000;
            }

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
            body_raw: respBodyRaw,
            first_chunk_timestamp: firstChunkTimestamp || null
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
