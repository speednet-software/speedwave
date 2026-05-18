# Speedwave MCP Context7 Worker
# Up-to-date library documentation via Context7 REST API.
#
# Security:
# - Optional API key mounted at /tokens/api_key (anonymous mode if absent)
# - No access to other service tokens
# - Per-IP rate limit when anonymous (~200/day) — see docs/architecture/security.md

# Build stage
FROM node:24-alpine AS builder

WORKDIR /build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build shared library first (dependency)
# ─────────────────────────────────────────────────────────────────────────────
COPY tsconfig.base.json ./
COPY shared/package*.json ./shared/
RUN --mount=type=cache,target=/root/.npm cd shared && npm install

COPY shared/src ./shared/src
COPY shared/tsconfig.json ./shared/
RUN cd shared && npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Build worker (imports from ../shared/dist)
# ─────────────────────────────────────────────────────────────────────────────
COPY context7/package*.json ./context7/
RUN --mount=type=cache,target=/root/.npm cd context7 && npm install

COPY context7/src ./context7/src
COPY context7/tsconfig.json ./context7/
RUN cd context7 && npm run build

# Prune devDependencies
RUN cd context7 && npm prune --omit=dev

# Production stage
FROM node:24-alpine

# curl for healthcheck; tzdata for TZ env — keep aligned with tz.rs (see CLAUDE.md SSOT).
RUN apk add --no-cache curl tzdata

WORKDIR /app

# Copy built shared library (required at runtime for relative imports)
COPY --from=builder /build/shared/dist ../shared/dist
COPY --from=builder /build/shared/package.json ../shared/
COPY --from=builder /build/shared/node_modules ../shared/node_modules

# Copy built worker application
COPY --from=builder /build/context7/package*.json ./
COPY --from=builder /build/context7/dist ./dist
COPY --from=builder /build/context7/node_modules ./node_modules

# Create tokens and project config directories
RUN mkdir -p /tokens /project && chown -R node:node /tokens /project /app /app/../shared

# Security: non-root user
USER node

# Health check (LOCAL readiness — does NOT hit Context7 API to preserve anonymous quota)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:3000/health || exit 1

EXPOSE 3000

ENV PORT=3000 \
    TOKENS_DIR=/tokens \
    NODE_ENV=production

CMD ["node", "dist/index.js"]
