# Speedwave MCP Redmine Worker
# Isolated Redmine API access with per-service token isolation
#
# Security:
# - ONLY has access to Redmine API key (mounted to /tokens/)
# - No access to other service tokens (SharePoint, Slack, etc.)
# - Blast radius containment: compromise of this worker only exposes Redmine

# Build stage
FROM node:25-alpine AS builder

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
COPY redmine/package*.json ./redmine/
RUN --mount=type=cache,target=/root/.npm cd redmine && npm install

COPY redmine/src ./redmine/src
COPY redmine/tsconfig.json ./redmine/
RUN cd redmine && npm run build

# Prune devDependencies
RUN cd redmine && npm prune --omit=dev

# Production stage
FROM node:25-alpine

# curl for healthcheck
RUN apk add --no-cache curl

WORKDIR /app

# Copy built shared library (required at runtime for relative imports)
COPY --from=builder /build/shared/dist ../shared/dist
COPY --from=builder /build/shared/package.json ../shared/
COPY --from=builder /build/shared/node_modules ../shared/node_modules

# Copy built worker application
COPY --from=builder /build/redmine/package*.json ./
COPY --from=builder /build/redmine/dist ./dist
COPY --from=builder /build/redmine/node_modules ./node_modules

# Create tokens and config directories
RUN mkdir -p /tokens /project && chown -R node:node /tokens /project /app /app/../shared

# Security: non-root user
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:3003/health || exit 1

EXPOSE 3003

ENV PORT=3003 \
    TOKENS_DIR=/tokens \
    PROJECT_CONFIG=/project/project.json \
    NODE_ENV=production

CMD ["node", "dist/index.js"]
