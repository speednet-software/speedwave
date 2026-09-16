
FROM node:24-alpine@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0 AS builder
WORKDIR /build

COPY tsconfig.base.json ./
COPY shared/package*.json ./shared/
RUN --mount=type=cache,target=/root/.npm cd shared && npm install
COPY shared/src ./shared/src
COPY shared/tsconfig.json ./shared/
RUN cd shared && npm run build

COPY office/package*.json ./office/
RUN --mount=type=cache,target=/root/.npm cd office && npm install
RUN cd office \
    && SHEETJS_VERSION=0.20.3 \
    && SHEETJS_SHA256=8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8 \
    && wget -q -O /tmp/xlsx.tgz "https://cdn.sheetjs.com/xlsx-${SHEETJS_VERSION}/xlsx-${SHEETJS_VERSION}.tgz" \
    && echo "${SHEETJS_SHA256}  /tmp/xlsx.tgz" | sha256sum -c - \
    && npm install --no-save /tmp/xlsx.tgz \
    && rm /tmp/xlsx.tgz
COPY office/src ./office/src
COPY office/tsconfig.json ./office/
RUN cd office && npm run build
RUN cd office && npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
WORKDIR /app

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      poppler-utils \
      pandoc \
      python3 python3-pip python3-venv \
      libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
      fonts-liberation fonts-dejavu-core \
      curl ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY office/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/office-venv \
    && /opt/office-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/office-venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

COPY --from=builder /build/shared/dist ../shared/dist
COPY --from=builder /build/shared/package.json ../shared/
COPY --from=builder /build/shared/node_modules ../shared/node_modules

COPY --from=builder /build/office/package*.json ./
COPY --from=builder /build/office/dist ./dist
COPY --from=builder /build/office/node_modules ./node_modules
COPY office/scripts ./scripts

ENV PATH="/opt/office-venv/bin:${PATH}"
RUN mkdir -p /workspace \
    && chown -R node:node /workspace /app /app/../shared

USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:3000/health || exit 1


ENV PORT=3000 \
    NODE_ENV=production \
    HOME=/tmp/lo \
    XDG_CACHE_HOME=/tmp \
    XDG_CONFIG_HOME=/tmp \
    MPLCONFIGDIR=/tmp/mpl \
    OFFICE_VENV=/opt/office-venv

CMD ["/bin/sh", "-c", "mkdir -p /tmp/lo /tmp/mpl && exec node dist/index.js"]
