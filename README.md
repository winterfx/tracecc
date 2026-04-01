# tracecc

AI API request tracing proxy with Web UI, log analysis, and visual report generation.

## Installation

```bash
npm install
```

## Usage

```bash
npm start
# or
make start
```

Open `http://localhost:3001` to access the Web UI. The browser opens automatically on start.

### Pages

- **Proxy** (`/`) - Configure and control the tracing proxy
- **Analyze** (`/analyze`) - Browse log files from `~/.claude/projects/` and view usage analytics (token usage, cost, model breakdown, etc.)
- **Report** (`/report/<file>`) - Visual report with conversations, raw API calls, and request simulator

### Proxy Workflow

1. Enter target domain (e.g., `https://api.anthropic.com`)
2. Optionally enter paths to skip logging (comma-separated)
3. Click **START** - proxy launches on port `8080`
4. Claude Code's `ANTHROPIC_BASE_URL` is automatically updated to use the proxy
5. Click **STOP** - proxy stops and `ANTHROPIC_BASE_URL` is restored

### Analyze Workflow

1. Navigate to the **Analyze** page
2. Browse `~/.claude/projects/` to find `.jsonl` log files
3. Select one or more files to view token usage, cost breakdown, and model statistics

### Generate Report

Click **View Report** from the Proxy page after a session, or run manually:

```bash
node generate-report.js <input.jsonl> [output.html]
```

## Log Format

JSONL format, filename `log-<timestamp>.jsonl`:

```json
{
  "request": { "timestamp": 1234.56, "method": "POST", "url": "...", "headers": {}, "body": {} },
  "response": { "timestamp": 1234.78, "status_code": 200, "headers": {}, "body": {}, "body_raw": "...", "first_chunk_timestamp": null },
  "logged_at": "2025-10-12T10:30:00.000Z"
}
```

Supports SSE stream capture with real-time forwarding.

## Makefile

```
make install   # Install dependencies
make start     # Start server
make stop      # Kill running server
make report    # Generate report from latest log
make clean     # Remove generated files and node_modules
```

## Tech Stack

Node.js, native HTTP proxy, vanilla HTML/CSS/JS, Chart.js

## License

MIT
