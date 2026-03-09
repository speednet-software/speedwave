# Speedwave MCP GitLab Worker
# Isolated GitLab API access with per-service token isolation
#
# Security:
# - ONLY has access to GitLab tokens (mounted to /tokens/)
# - No access to other service tokens (Slack, SharePoint, Redmine, etc.)
# - Blast radius containment: compromise of this worker only exposes GitLab

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
COPY gitlab/package*.json ./gitlab/
RUN --mount=type=cache,target=/root/.npm cd gitlab && npm install

COPY gitlab/src ./gitlab/src
COPY gitlab/tsconfig.json ./gitlab/
RUN cd gitlab && npm run build

# Prune devDependencies
RUN cd gitlab && npm prune --omit=dev

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
COPY --from=builder /build/gitlab/package*.json ./
COPY --from=builder /build/gitlab/dist ./dist
COPY --from=builder /build/gitlab/node_modules ./node_modules

# Create tokens and project config directories
RUN mkdir -p /tokens /project && chown -R node:node /tokens /project /app /app/../shared

# Security: non-root user
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:3004/health || exit 1

EXPOSE 3004

ENV PORT=3004 \
    TOKENS_DIR=/tokens \
    PROJECT_CONFIG_PATH=/project/project.json \
    NODE_ENV=production

CMD ["node", "dist/index.js"]
