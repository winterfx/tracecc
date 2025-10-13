import http from 'http';
import { URL } from 'url';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WEB_PORT = 3000;
const PROXY_PORT = 8080;

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
      const command = `npx claude-trace --generate-html ${logFile} ${htmlFile} --no-open`;

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

      // Read response body
      const respBuf = Buffer.from(await upstreamResp.arrayBuffer());

      // Parse response body if JSON or SSE stream
      let respBodyObj = null;
      if (respBuf.length > 0) {
        const contentType = upstreamResp.headers.get('content-type') || '';

        if (contentType.includes('text/event-stream')) {
          // Parse SSE (Server-Sent Events) stream
          const text = respBuf.toString('utf-8');
          const events = [];
          const lines = text.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6);
              if (dataStr.trim() && dataStr !== '[DONE]') {
                try {
                  events.push(JSON.parse(dataStr));
                } catch (e) {
                  // Invalid JSON in event, skip
                }
              }
            }
          }

          if (events.length > 0) {
            respBodyObj = { stream_events: events };
          }
        } else {
          // Try to parse as regular JSON
          try {
            respBodyObj = JSON.parse(respBuf.toString('utf-8'));
          } catch (e) {
            // Not JSON, keep as null
          }
        }
      }

      // Write response headers
      upstreamResp.headers.forEach((v, k) => {
        if (!['transfer-encoding','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','upgrade'].includes(k.toLowerCase())) {
          res.setHeader(k, v);
        }
      });
      res.statusCode = upstreamResp.status;
      res.end(respBuf);

      // Console log
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} -> ${upstreamResp.status} (req ${reqBody.length}B, resp ${respBuf.length}B) ${shouldBypass ? '[BYPASS]' : ''}`);

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
            body: respBodyObj
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
});
