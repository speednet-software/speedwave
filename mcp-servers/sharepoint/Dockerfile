# Speedwave MCP SharePoint Worker
# Isolated SharePoint/Microsoft Graph API access with per-service token isolation
#
# Security:
# - ONLY has access to SharePoint tokens (mounted to /tokens/)
# - No access to other service tokens (Slack, Redmine, etc.)
# - Blast radius containment: compromise of this worker only exposes SharePoint

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
COPY sharepoint/package*.json ./sharepoint/
RUN --mount=type=cache,target=/root/.npm cd sharepoint && npm install

COPY sharepoint/src ./sharepoint/src
COPY sharepoint/tsconfig.json ./sharepoint/
RUN cd sharepoint && npm run build

# Prune devDependencies
RUN cd sharepoint && npm prune --omit=dev

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
COPY --from=builder /build/sharepoint/package*.json ./
COPY --from=builder /build/sharepoint/dist ./dist
COPY --from=builder /build/sharepoint/node_modules ./node_modules

# Create tokens and context directories
RUN mkdir -p /tokens /context && chown -R node:node /tokens /context /app /app/../shared

# Security: non-root user
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:3002/health || exit 1

EXPOSE 3002

ENV PORT=3002 \
    TOKENS_DIR=/tokens \
    CONTEXT_DIR=/context \
    NODE_ENV=production

CMD ["node", "dist/index.js"]
