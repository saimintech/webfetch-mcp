# ── Stage 1: install deps ──────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
# Install production deps only
RUN npm ci --omit=dev

# ── Stage 2: lean runtime ──────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Copy deps and source
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server-http.mjs ./

# Cloud Run injects $PORT (default 8080)
ENV PORT=8080
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

EXPOSE 8080

# Use dumb-init to forward signals properly inside Docker
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server-http.mjs"]
