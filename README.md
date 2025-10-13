# tracecc

AI API request tracing proxy with Web UI control and visual report generation.
<img width="875" height="710" alt="image" src="https://github.com/user-attachments/assets/d8e58ec7-c871-4bd7-bef7-120ea5a6edb3" />
<img width="802" height="906" alt="image" src="https://github.com/user-attachments/assets/0ae10cd6-41e4-447e-b552-e3e1a0a5be73" />


## Installation

```bash
npm install
```

## Configuration (Optional)

To set default values for the UI (for privacy and convenience), create a `.env` file:

```bash
cp .env.example .env
```

Edit `.env` with your preferred defaults:

```env
UI_DEFAULT_DOMAIN=https://api.example.com
UI_DEFAULT_BYPASS_PATHS=/health,/metrics
```

**Important:** The `.env` file is git-ignored to protect your privacy. Never commit it to version control.

## Usage

```bash
npm start
```

Open `http://localhost:3000`, configure target domain and bypass paths (or use defaults from `.env`), then start the proxy (listening on port 8080).

### Web UI Workflow

1. Enter target domain (e.g., `https://api.example.com`)
2. Enter paths to skip logging, comma-separated (optional)
3. Click [START] to launch proxy
4. Configure your client to use proxy `http://localhost:8080`
5. Click [STOP] to stop and generate HTML report

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
