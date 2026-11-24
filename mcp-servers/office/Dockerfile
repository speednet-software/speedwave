
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS builder
WORKDIR /build

COPY tsconfig.base.json package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY office/package.json ./office/
RUN --mount=type=cache,target=/root/.npm npm ci --workspace=office --ignore-scripts
COPY shared/src ./shared/src
COPY shared/tsconfig.json ./shared/
RUN npm run build --workspace=shared

COPY office/src ./office/src
COPY office/tsconfig.json ./office/
RUN npm run build --workspace=office
RUN npm prune --omit=dev --workspace=office --ignore-scripts

FROM python:3.13-slim-bookworm@sha256:a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72 AS python-src

FROM node:24-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
WORKDIR /app

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      poppler-utils \
      pandoc \
      libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
      fonts-liberation fonts-dejavu-core \
      curl ca-certificates tzdata \
      libssl3 libffi8 libbz2-1.0 liblzma5 libsqlite3-0 libuuid1 zlib1g \
    && rm -rf /var/lib/apt/lists/*

# Python 3.13 for the venv comes from the official python image (bookworm, same glibc as this
# base), not from apt: bookworm's python3 is 3.11.2 and soupsieve 4.x needs >=3.11.5.
# lock-office.sh --python-version must match this minor version.
COPY --from=python-src /usr/local/bin/python3.13 /usr/local/bin/python3.13
COPY --from=python-src /usr/local/lib/libpython3.13.so.1.0 /usr/local/lib/libpython3.13.so.1.0
COPY --from=python-src /usr/local/lib/python3.13 /usr/local/lib/python3.13
RUN ldconfig \
    && /usr/local/bin/python3.13 -m compileall -q /usr/local/lib/python3.13

COPY office/requirements.txt /tmp/requirements.txt
RUN /usr/local/bin/python3.13 -m venv /opt/office-venv \
    && /opt/office-venv/bin/pip install --no-cache-dir --require-hashes --no-deps -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

COPY --from=builder /build/shared/dist ./shared/dist
COPY --from=builder /build/shared/package.json ./shared/
COPY --from=builder /build/node_modules ./node_modules

COPY --from=builder /build/office/package.json ./
COPY --from=builder /build/office/dist ./dist
COPY office/scripts ./scripts

ENV PATH="/opt/office-venv/bin:${PATH}"
RUN mkdir -p /workspace \
    && chown -R node:node /workspace /app

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
