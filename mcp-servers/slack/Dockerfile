# Speedwave MCP Slack Worker
# Isolated Slack API access with per-service token isolation
#
# Security:
# - ONLY has access to Slack tokens (mounted to /tokens/)
# - No access to other service tokens (SharePoint, Redmine, etc.)
# - Blast radius containment: compromise of this worker only exposes Slack

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
COPY slack/package*.json ./slack/
RUN --mount=type=cache,target=/root/.npm cd slack && npm install

COPY slack/src ./slack/src
COPY slack/tsconfig.json ./slack/
RUN cd slack && npm run build

# Prune devDependencies
RUN cd slack && npm prune --omit=dev

# Production stage
FROM node:24-alpine

# curl for healthcheck
RUN apk add --no-cache curl

WORKDIR /app

# Copy built shared library (required at runtime for relative imports)
COPY --from=builder /build/shared/dist ../shared/dist
COPY --from=builder /build/shared/package.json ../shared/
COPY --from=builder /build/shared/node_modules ../shared/node_modules

# Copy built worker application
COPY --from=builder /build/slack/package*.json ./
COPY --from=builder /build/slack/dist ./dist
COPY --from=builder /build/slack/node_modules ./node_modules

# Create tokens directory
RUN mkdir -p /tokens && chown -R node:node /tokens /app /app/../shared

# Security: non-root user
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:3001/health || exit 1

EXPOSE 3001

ENV PORT=3001 \
    TOKENS_DIR=/tokens \
    NODE_ENV=production

CMD ["node", "dist/index.js"]
