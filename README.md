# webfetch-mcp

An MCP server over HTTP that gives an LLM client two tools: web search (through a SearxNG instance) and readable page fetching (through Mozilla Readability).

## How it works

```
MCP client (any StreamableHTTP client)
    |
    |  POST/GET/DELETE /mcp
    v
webfetch-mcp  (this repo, Node.js)
    |-- web_search --> SearxNG  /search?format=json  --> search engines
    '-- web_fetch  --> target URL --> JSDOM + Readability --> plain text
```

`server-http.mjs` runs a plain Node HTTP server and exposes the MCP SDK's StreamableHTTP transport, so it can run as a long-lived container (it was written with Cloud Run in mind). The search backend is a separate service; a matching SearxNG setup lives in the companion repo `searxng-mcp`.

This is an HTTP adaptation of the stdio `webfetch-mcp` server by Jay Leon (MIT, github.com/manull/webfetch-mcp). The original MIT notice is kept in `LICENSE`.

### Tools

| Tool | Inputs | What it returns |
|------|--------|-----------------|
| `web_search` | `query` (required), `limit` (1-20, default 5), `site`, `engines`, `language`, `safesearch` (0-2), `page`, `time_range` (day/week/month/year) | Numbered list of title, URL, snippet and engine |
| `web_fetch` | `url` (required, http/https), `max_chars` (default 20000) | Page title, byline if any, and the extracted text |

### Behaviour worth knowing

- `web_fetch` only extracts `text/html` and `application/xhtml` responses. It strips scripts, nav, headers, footers and common ad/sidebar blocks, runs Readability, and falls back to the largest `main`/`article`/content block when Readability finds too little text.
- Fetches send browser-like headers with a rotating User-Agent, wait at least 1 second between requests to the same host, and retry once on HTTP 429/502/503/504.
- Timeouts: 15 s for search, 20 s for fetch.
- A simple in-process rate limit applies to all tool calls: 12 calls per 5 minutes, at most 8 in any 30 second burst.
- MCP sessions are kept in memory, so run a single instance (or use session affinity).

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/mcp` | MCP messages (creates a session on first call) |
| GET | `/mcp` | SSE stream |
| DELETE | `/mcp` | Close a session (`mcp-session-id` header) |
| GET | `/health` | Liveness check, returns `{"status":"ok", ...}` |

## Stack

Node.js 20, `@modelcontextprotocol/sdk`, `jsdom`, `@mozilla/readability`. Docker image based on `node:20-slim` with `dumb-init`.

## Run locally

You need a SearxNG instance with JSON output enabled (see `searxng-mcp`). Both default to port 8080, so put one of them on another port.

```bash
npm ci
SEARXNG_BASE=http://localhost:8888 PORT=8080 node server-http.mjs
```

`npm start` runs the same thing (`node server-http.mjs`).

## Run with Docker

```bash
docker build -t webfetch-mcp .
docker run --rm -p 8080:8080 -e SEARXNG_BASE=http://<searxng-host>:8080 webfetch-mcp
```

## Deploy to Cloud Run (example)

```bash
gcloud run deploy webfetch-mcp \
  --source . \
  --region <region> \
  --set-env-vars SEARXNG_BASE=<searxng-url> \
  --max-instances 1
```

The server does not authenticate MCP clients itself and sends no auth headers to SearxNG. Put access control in front of it (Cloud Run IAM, a gateway, or a private network) if it is reachable from the internet.

## Quick test

```bash
curl http://localhost:8080/health

curl -X POST http://localhost:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Any MCP client that speaks StreamableHTTP can then point at `http://<host>:8080/mcp`.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | HTTP listen port |
| `SEARXNG_BASE` | `http://localhost:8080` | Base URL of the SearxNG instance |
| `DEBUG` | unset | Set to `true` for debug logging |

## Author

Built by Saim Safdar - https://saim.me
