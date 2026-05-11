# Speedwave MCP Office Worker
# Read/write/create/convert Word, Excel, PowerPoint, PDF; render charts. A pure file processor:
# no service credentials, no /tokens mount, no network egress (compose attaches it to an
# `internal: true` network). Only mounts the project workspace at /workspace:rw. See ADR-055.
#
# Security:
# - No service tokens. The only credential is the internal Bearer MCP_OFFICE_AUTH_TOKEN.
# - Blast radius: a compromised parser is confined to /workspace and cannot reach the network.

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: build the shared library + the office worker (TypeScript)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /build

COPY tsconfig.base.json ./
COPY shared/package*.json ./shared/
RUN --mount=type=cache,target=/root/.npm cd shared && npm install
COPY shared/src ./shared/src
COPY shared/tsconfig.json ./shared/
RUN cd shared && npm run build

COPY office/package*.json ./office/
RUN --mount=type=cache,target=/root/.npm cd office && npm install
COPY office/src ./office/src
COPY office/tsconfig.json ./office/
RUN cd office && npm run build
RUN cd office && npm prune --omit=dev

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: runtime — Debian (LibreOffice is poorly packaged on Alpine)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim
WORKDIR /app

# Document toolchain. `--no-install-recommends` keeps the image down; `libreoffice-l10n-*` and
# `-base`/`-draw`/`-math` are deliberately omitted. tzdata is required — keep aligned with
# crates/speedwave-runtime/src/tz.rs (see CLAUDE.md SSOT-alignment).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      poppler-utils \
      pandoc \
      python3 python3-pip python3-venv \
      fonts-liberation fonts-dejavu-core \
      curl ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

# Python venv for the support-scripts + WeasyPrint. Pinned via requirements.txt.
COPY office/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/office-venv \
    && /opt/office-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/office-venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

# Built shared library (needed at runtime for relative imports).
COPY --from=builder /build/shared/dist ../shared/dist
COPY --from=builder /build/shared/package.json ../shared/
COPY --from=builder /build/shared/node_modules ../shared/node_modules

# Built worker + the Python support-scripts.
COPY --from=builder /build/office/package*.json ./
COPY --from=builder /build/office/dist ./dist
COPY --from=builder /build/office/node_modules ./node_modules
COPY office/scripts ./scripts

# Workspace mount point + scratch dirs (LibreOffice profile, matplotlib config).
# `markitdown` console entry point lives in the venv — expose it on PATH.
ENV PATH="/opt/office-venv/bin:${PATH}"
RUN mkdir -p /workspace /tmp/lo /tmp/mpl \
    && chown -R node:node /workspace /tmp/lo /tmp/mpl /app /app/../shared

USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:3000/health || exit 1

# No EXPOSE — built-in workers are reached only over the internal compose network.

ENV PORT=3000 \
    NODE_ENV=production \
    HOME=/tmp/lo \
    XDG_CACHE_HOME=/tmp \
    XDG_CONFIG_HOME=/tmp \
    MPLCONFIGDIR=/tmp/mpl \
    OFFICE_VENV=/opt/office-venv

CMD ["node", "dist/index.js"]
