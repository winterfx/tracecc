import http from 'http';
import { URL } from 'url';
import fs from 'fs';

const PORT = 8080;
const TARGET = 'https://api.rdsec.trendmicro.com';
// Bypass paths - configure which endpoints should not be logged
const BYPASS_PATHS = ['/prod/aiendpoint/v1/messages/count_tokens'];

// Generate log file name with timestamp
const now = new Date();
const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
const LOG_FILE = `./log-${timestamp}.jsonl`;

const server = http.createServer(async (req, res) => {
  try {
    const requestTimestamp = Date.now() / 1000; // Unix timestamp in seconds with decimals
    const targetUrl = new URL(req.url, TARGET);

    // Check if this path should be bypassed from logging
    const shouldBypass = BYPASS_PATHS.some(path => req.url.includes(path));

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
            const dataStr = line.slice(6); // Remove 'data: ' prefix
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

    // Write response headers (filter hop-by-hop headers)
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
    if (!shouldBypass) {
      // Create log entry matching the reference format
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
      fs.appendFile(LOG_FILE, JSON.stringify(logEntry) + '\n', (err) => {
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

server.listen(PORT, () => {
  console.log(`Proxy listening on http://0.0.0.0:${PORT}, forwarding to ${TARGET}`);
  console.log(`Logging to: ${LOG_FILE}`);
});

