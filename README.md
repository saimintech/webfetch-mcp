# WebFetch MCP — Cloud Run

Two Cloud Run services that give LiteLLM (or any MCP client) live web search and page fetching.

```
LiteLLM Proxy
    └── MCP (StreamableHTTP) ──► webfetch-mcp   (Cloud Run, public)
                                      └── HTTP ──► searxng  (Cloud Run, internal)
                                                       └── Google, Bing, DDG, arXiv...
```

---

## Services

| Service | Image | Public? | Purpose |
|---------|-------|---------|---------|
| `webfetch-mcp` | Node.js 20 + JSDOM + Readability | ✅ Yes | MCP server |
| `searxng` | Official SearxNG | 🔒 Internal only | Metasearch engine |

**MCP Tools exposed:**
| Tool | Description |
|------|-------------|
| `web_search` | Search via SearxNG (Google, Bing, DDG, arXiv, GitHub, etc.) |
| `web_fetch` | Fetch + extract readable text from any URL via Mozilla Readability |

---

## Prerequisites

- Google Cloud SDK installed and authenticated (`gcloud auth login`)
- A GCP project with billing enabled
- `openssl` available locally (for secret generation)

---

## Deploy

```bash
chmod +x deploy.sh
./deploy.sh YOUR_GCP_PROJECT_ID [REGION]

# Example
./deploy.sh my-gcp-project us-central1
```

The script:
1. Enables required GCP APIs
2. Generates a SearxNG secret key and stores it in Secret Manager
3. Builds and deploys SearxNG (internal-only)
4. Grants webfetch-mcp's service account invoker access to SearxNG
5. Builds and deploys webfetch-mcp with `SEARXNG_BASE` pointed at SearxNG
6. Prints the MCP endpoint URL

---

## LiteLLM Integration

Add to your `litellm_config.yaml`:

```yaml
mcp_servers:
  - name: webfetch
    url: https://YOUR-MCP-SERVICE.run.app/mcp
```

Or with the Python SDK:

```python
import litellm

response = litellm.completion(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Search for the latest AI news"}],
    mcp_servers=[{
        "name": "webfetch",
        "url": "https://YOUR-MCP-SERVICE.run.app/mcp"
    }]
)
```

---

## Cloud Run Settings

### webfetch-mcp
| Setting | Value | Reason |
|---------|-------|--------|
| Memory | 512Mi | JSDOM parses full HTML pages in-process |
| CPU | 1 | Node.js is single-threaded; extra CPUs don't help much |
| Concurrency | 10 | Each request does async I/O — safe to interleave |
| Min instances | 1 | Keep warm — MCP clients have short connection timeouts |
| Auth | Public | LiteLLM connects without GCP credentials |

### searxng
| Setting | Value | Reason |
|---------|-------|--------|
| Memory | 512Mi | Python app with multiple engine workers |
| Concurrency | 80 | SearxNG is designed for high concurrency |
| Min instances | 1 | Keep warm — cold start would cascade into MCP timeouts |
| Auth | Internal only | Only webfetch-mcp can call it |

---

## Cost Estimate

Both services at min-instances=1 in us-central1:

| | CPU | Memory | ~Monthly idle |
|-|-----|--------|--------------|
| webfetch-mcp | 1 vCPU | 512Mi | ~$8 |
| searxng | 1 vCPU | 512Mi | ~$8 |
| **Total** | | | **~$16/month** |

Set `--min-instances=0` on both to go scale-to-zero (~$0 idle, but expect 5–8s cold starts).

---

## Testing

```bash
# Health check
curl https://YOUR-MCP-URL.run.app/health

# The MCP endpoint speaks StreamableHTTP — test with any MCP client
# or via LiteLLM as shown above
```

---

## File Structure

```
.
├── deploy.sh                     ← run this
├── webfetch-mcp-cloudrun/
│   ├── server-http.mjs           ← HTTP MCP server (StreamableHTTP transport)
│   ├── Dockerfile
│   └── package.json
└── searxng-cloudrun/
    ├── Dockerfile
    ├── entrypoint.sh             ← injects SECRET_KEY at runtime
    └── searxng/
        └── settings.yml          ← JSON output enabled, limiter off
```
