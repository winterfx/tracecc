# tracecc

AI API request tracing proxy with Web UI control and visual report generation.

## Installation

```bash
npm install
```

## Usage

```bash
npm start
```

Open `http://localhost:3000`, configure target domain and bypass paths, then start the proxy (listening on port 8080).

### Web UI Workflow

1. Enter target domain (e.g., `https://api.example.com`)
2. Enter paths to skip logging, comma-separated (optional)
3. Click [START] to launch proxy
4. Configure your client to use proxy `http://localhost:8080`
5. Click [STOP] to stop and generate HTML report

### Direct Proxy Mode

Modify `TARGET` and `BYPASS_PATHS` in `proxy.js`, then run:

```bash
npm run proxy
```

## Log Format

JSONL format, filename `log-<timestamp>.jsonl`:

```json
{
  "request": { "timestamp": 1234.56, "method": "POST", "url": "...", "headers": {...}, "body": {...} },
  "response": { "timestamp": 1234.78, "status_code": 200, "headers": {...}, "body": {...} },
  "logged_at": "2025-10-12T10:30:00.000Z"
}
```

Supports SSE stream parsing.

## Generate Reports

Click "Generate Report" button in Web UI, or run manually:

```bash
npx claude-trace --generate-html log-xxx.jsonl report.html --no-open
```

## Tech Stack

Node.js, HTTP Proxy, claude-trace, vanilla HTML/CSS/JS

## License

ISC
