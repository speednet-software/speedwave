# Speedwave MCP Gemini Worker
# AI-powered codebase analysis and grounded search
#
# Security:
# - ONLY has access to Gemini API key (mounted to /tokens/api_key)
# - No access to other service tokens (Slack, SharePoint, etc.)
# - Read-only workspace mount at /workspace
# - Blast radius containment: compromise only exposes Gemini API

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
COPY gemini/package*.json ./gemini/
RUN --mount=type=cache,target=/root/.npm cd gemini && npm install

COPY gemini/src ./gemini/src
COPY gemini/tsconfig.json ./gemini/
RUN cd gemini && npm run build

# Prune devDependencies
RUN cd gemini && npm prune --omit=dev

# Production stage
FROM node:24-alpine

# Install curl for healthcheck, bash for scripts, and build tools for native modules
RUN apk add --no-cache curl bash python3 make g++

WORKDIR /app

# Copy built shared library (required at runtime for relative imports)
COPY --from=builder /build/shared/dist ../shared/dist
COPY --from=builder /build/shared/package.json ../shared/
COPY --from=builder /build/shared/node_modules ../shared/node_modules

# Copy built worker application
COPY --from=builder /build/gemini/package*.json ./
COPY --from=builder /build/gemini/dist ./dist
COPY --from=builder /build/gemini/node_modules ./node_modules

# Install Google Gemini CLI globally (required for chat tool)
RUN npm install -g @google/gemini-cli

# Create required directories
# Note: /home/node/.gemini is provided via tmpfs mount in docker-compose
RUN mkdir -p /tokens /workspace && \
    chown -R node:node /tokens /workspace /app /app/../shared

# Security: non-root user
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:3005/health || exit 1

EXPOSE 3005

ENV PORT=3005 \
    TOKENS_DIR=/tokens \
    WORKSPACE_DIR=/workspace \
    GEMINI_CONFIG_DIR=/app/.gemini \
    NODE_ENV=production

CMD ["node", "dist/index.js"]
