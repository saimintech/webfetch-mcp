#!/usr/bin/env node

/**
 * WebFetch.MCP — Cloud Run HTTP entry point
 *
 * Wraps the core MCP server (tools, handlers) with a StreamableHTTP transport
 * instead of stdio, so it can run as a long-lived HTTP service on Cloud Run.
 *
 * Endpoints:
 *   POST /mcp        — MCP client sends messages here
 *   GET  /mcp        — MCP client opens SSE stream here
 *   DELETE /mcp      — MCP client tears down session
 *   GET  /health     — Cloud Run health / liveness probe
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "8080", 10);
const SEARXNG_BASE = process.env.SEARXNG_BASE || "http://localhost:8080";
const DEBUG = process.env.DEBUG === "true";

// ─── Logging (stdout only — Cloud Logging picks this up automatically) ────────

const log = (...args) => {
  if (DEBUG) console.log("[DEBUG]", new Date().toISOString(), ...args);
};

const info = (...args) => console.log("[INFO]", new Date().toISOString(), ...args);
const warn = (...args) => console.warn("[WARN]", new Date().toISOString(), ...args);
const err  = (...args) => console.error("[ERROR]", new Date().toISOString(), ...args);

// ─── Rate limiting ────────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const MAX_CALLS_PER_WINDOW = 12;
const BURST_LIMIT = 8;
const BURST_WINDOW_MS = 30 * 1000;

let callHistory = [];

const checkCallLimit = () => {
  const now = Date.now();
  callHistory = callHistory.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  const recentCalls = callHistory.filter(t => now - t < BURST_WINDOW_MS);

  if (recentCalls.length >= BURST_LIMIT) {
    const waitSec = Math.ceil((BURST_WINDOW_MS - (now - recentCalls[0])) / 1000);
    return { limited: true, message: `Burst limit reached. Wait ${waitSec}s.` };
  }
  if (callHistory.length >= MAX_CALLS_PER_WINDOW) {
    const resetMin = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - Math.min(...callHistory))) / 60000);
    return { limited: true, message: `Rate limit reached. Resets in ${resetMin} min.` };
  }

  callHistory.push(now);
  const remaining = MAX_CALLS_PER_WINDOW - callHistory.length;
  return {
    limited: false,
    warning: remaining <= 2 ? `⚠️ ${remaining} calls remaining in this window.` : null,
  };
};

// ─── Per-domain fetch rate limiting ───────────────────────────────────────────

const requestTimes = new Map();
const DOMAIN_RATE_LIMIT_MS = 1000;

const applyDomainRateLimit = async (hostname) => {
  const last = requestTimes.get(hostname) || 0;
  const wait = DOMAIN_RATE_LIMIT_MS - (Date.now() - last);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  requestTimes.set(hostname, Date.now());
};

// ─── Browser headers ──────────────────────────────────────────────────────────

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
];

const getBrowserHeaders = (url) => ({
  "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Referer": `https://${new URL(url).hostname}/`,
});

const safeText = (s = "", max = 20000) =>
  String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function handleWebSearch(args) {
  const limitCheck = checkCallLimit();
  if (limitCheck.limited) return { content: [{ type: "text", text: limitCheck.message }] };

  const { query, limit = 5, site, engines, language, safesearch, page = 1, time_range } = args;
  if (!query) return { content: [{ type: "text", text: "Missing required parameter: query" }] };

  try {
    const searchQuery = site ? `${query} site:${site}` : query;
    const url = new URL("/search", SEARXNG_BASE);
    url.searchParams.set("format", "json");
    url.searchParams.set("q", searchQuery);
    url.searchParams.set("pageno", String(page));
    url.searchParams.set("categories", "general");
    url.searchParams.set("count", String(Math.min(limit, 20)));
    if (engines)                         url.searchParams.set("engines", engines);
    if (language)                        url.searchParams.set("language", language);
    if (typeof safesearch === "number")  url.searchParams.set("safesearch", String(safesearch));
    if (time_range)                      url.searchParams.set("time_range", time_range);

    log("Searching:", url.toString());

    const response = await fetch(url.toString(), {
      headers: { "User-Agent": "MCP-WebFetch/0.1.8", "Accept": "application/json" },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return { content: [{ type: "text", text: `Search failed: HTTP ${response.status}` }] };

    const data = await response.json();
    const rawResults = data.results || [];

    if (rawResults.length === 0) return { content: [{ type: "text", text: `No results for: "${query}"` }] };

    const results = rawResults.slice(0, limit).map((item, i) => ({
      title: safeText(item.title || "No title", 300),
      url: item.url || "",
      snippet: safeText(item.content || item.description || "", 500),
      engine: item.engine || "unknown",
    }));

    let text = `Search results for "${query}":\n\n`;
    results.forEach((r, i) => {
      text += `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}\n   [${r.engine}]\n\n`;
    });
    text += `${results.length} results`;
    if (data.number_of_results) text += ` (${data.number_of_results} total)`;
    if (limitCheck.warning) text += `\n\n${limitCheck.warning}`;

    return { content: [{ type: "text", text }] };
  } catch (e) {
    err("web_search error:", e.message);
    return { content: [{ type: "text", text: `Search failed: ${e.message}` }] };
  }
}

async function handleWebFetch(args) {
  const limitCheck = checkCallLimit();
  if (limitCheck.limited) return { content: [{ type: "text", text: limitCheck.message }] };

  const { url, max_chars = 20000, retry_count = 0 } = args;
  if (!url) return { content: [{ type: "text", text: "Missing required parameter: url" }] };

  let validUrl;
  try {
    validUrl = new URL(url);
    if (!["http:", "https:"].includes(validUrl.protocol)) throw new Error("Only HTTP/HTTPS URLs supported");
  } catch (e) {
    return { content: [{ type: "text", text: `Invalid URL: ${e.message}` }] };
  }

  try {
    await applyDomainRateLimit(validUrl.hostname);
    if (retry_count === 0) await new Promise(r => setTimeout(r, Math.random() * 500 + 200));

    const response = await fetch(validUrl.toString(), {
      headers: getBrowserHeaders(validUrl.toString()),
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });

    if (!response.ok) {
      if (retry_count === 0 && [429, 502, 503, 504].includes(response.status)) {
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
        return handleWebFetch({ ...args, retry_count: 1 });
      }
      return { content: [{ type: "text", text: `Fetch failed: HTTP ${response.status}` }] };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return { content: [{ type: "text", text: `Cannot extract text from ${contentType} content.` }] };
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url: validUrl.toString(), pretendToBeVisual: true });
    const document = dom.window.document;

    // Remove noise
    ["script","style","nav","header","footer","aside",".advertisement",".ads",".sidebar"].forEach(sel => {
      document.querySelectorAll(sel).forEach(el => el.remove());
    });

    const reader = new Readability(document);
    const article = reader.parse();

    let extracted;
    if (article?.textContent?.trim().length > 100) {
      extracted = `**${article.title || document.title || "Untitled"}**\n\n`;
      if (article.byline) extracted += `By: ${article.byline}\n\n`;
      extracted += safeText(article.textContent, max_chars);
    } else {
      // Fallback: find best content block
      const selectors = ["main","article","[role='main']",".main-content",".content","#content","#main"];
      let best = "";
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.textContent || "";
          if (t.length > best.length) best = t;
        }
      }
      if (!best || best.trim().length < 100) best = document.body?.textContent || "";
      extracted = `**${document.title || "Untitled"}**\n\n` + safeText(best, max_chars);
    }

    if (limitCheck.warning) extracted += `\n\n${limitCheck.warning}`;
    return { content: [{ type: "text", text: extracted }] };

  } catch (e) {
    err("web_fetch error:", e.message);
    return { content: [{ type: "text", text: `Fetch failed: ${e.message}` }] };
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "web_search",
    description: "Search the web via SearxNG. Returns titles, URLs, and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query:       { type: "string", description: "Search query" },
        limit:       { type: "number", description: "Max results (1-20)", default: 5 },
        site:        { type: "string", description: "Restrict to a specific site, e.g. 'weather.gov'" },
        engines:     { type: "string", description: "Comma-separated SearxNG engines" },
        language:    { type: "string", description: "Language code, e.g. 'en'" },
        safesearch:  { type: "number", description: "0=off, 1=moderate, 2=strict" },
        page:        { type: "number", description: "Page number", default: 1 },
        time_range:  { type: "string", enum: ["day","week","month","year"] },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch and extract readable content from a URL using Mozilla Readability.",
    inputSchema: {
      type: "object",
      properties: {
        url:       { type: "string", description: "HTTP/HTTPS URL to fetch" },
        max_chars: { type: "number", description: "Max characters to return", default: 20000 },
      },
      required: ["url"],
    },
  },
];

// ─── MCP server factory ───────────────────────────────────────────────────────
// A new Server instance is created per session (required by StreamableHTTP).

function createMcpServer() {
  const server = new Server(
    { name: "webfetch-mcp", version: "0.1.8" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log("Tool called:", name);
    switch (name) {
      case "web_search": return handleWebSearch(args || {});
      case "web_fetch":  return handleWebFetch(args || {});
      default: throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}

// ─── Session store (in-memory, single instance) ───────────────────────────────

const sessions = new Map(); // sessionId → StreamableHTTPServerTransport

// ─── HTTP server ──────────────────────────────────────────────────────────────

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", searxng: SEARXNG_BASE }));
    return;
  }

  // MCP endpoint
  if (url.pathname === "/mcp") {
    try {
      if (req.method === "POST") {
        // Read body first so we can inspect the session ID header
        const body = await new Promise((resolve, reject) => {
          let data = "";
          req.on("data", chunk => (data += chunk));
          req.on("end", () => {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          });
          req.on("error", reject);
        });

        const sessionId = req.headers["mcp-session-id"];
        let transport = sessions.get(sessionId);

        if (!transport) {
          // New session — initialize
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, transport);
              info(`Session initialized: ${id} (total: ${sessions.size})`);
            },
            onsessionclosed: (id) => {
              sessions.delete(id);
              info(`Session closed: ${id} (total: ${sessions.size})`);
            },
          });

          const mcpServer = createMcpServer();
          mcpServer.onerror = (e) => err("MCP server error:", e);
          await mcpServer.connect(transport);
        }

        await transport.handleRequest(req, res, body);

      } else if (req.method === "GET") {
        // SSE stream — always creates a new transport/session
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
            info(`Session initialized: ${id} (total: ${sessions.size})`);
          },
          onsessionclosed: (id) => {
            sessions.delete(id);
            info(`Session closed: ${id} (total: ${sessions.size})`);
          },
        });

        const mcpServer = createMcpServer();
        mcpServer.onerror = (e) => err("MCP server error:", e);
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);

      } else if (req.method === "DELETE") {
        const sessionId = req.headers["mcp-session-id"];
        const transport = sessions.get(sessionId);
        if (transport) {
          await transport.handleRequest(req, res);
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
        }

      } else {
        res.writeHead(405);
        res.end("Method not allowed");
      }
    } catch (e) {
      err("Request handler error:", e.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // 404 for anything else
  res.writeHead(404);
  res.end("Not found");
});

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  info(`WebFetch MCP server listening on port ${PORT}`);
  info(`SearxNG base: ${SEARXNG_BASE}`);
  info(`MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  info(`Health check: http://0.0.0.0:${PORT}/health`);
});

process.on("SIGTERM", () => {
  info("SIGTERM received — shutting down gracefully");
  httpServer.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  info("SIGINT received — shutting down");
  httpServer.close(() => process.exit(0));
});
