
FROM node:24-alpine@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0 AS builder

WORKDIR /build

COPY tsconfig.base.json ./
COPY shared/package*.json ./shared/
RUN --mount=type=cache,target=/root/.npm cd shared && npm install

COPY shared/src ./shared/src
COPY shared/tsconfig.json ./shared/
RUN cd shared && npm run build

COPY gitlab/package*.json ./gitlab/
RUN --mount=type=cache,target=/root/.npm cd gitlab && npm install

COPY gitlab/src ./gitlab/src
COPY gitlab/tsconfig.json ./gitlab/
RUN cd gitlab && npm run build

RUN cd gitlab && npm prune --omit=dev

FROM node:24-alpine@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0

RUN apk add --no-cache curl tzdata

WORKDIR /app

COPY --from=builder /build/shared/dist ../shared/dist
COPY --from=builder /build/shared/package.json ../shared/
COPY --from=builder /build/shared/node_modules ../shared/node_modules

COPY --from=builder /build/gitlab/package*.json ./
COPY --from=builder /build/gitlab/dist ./dist
COPY --from=builder /build/gitlab/node_modules ./node_modules

RUN mkdir -p /tokens /project && chown -R node:node /tokens /project /app /app/../shared

USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:3004/health || exit 1

EXPOSE 3004

ENV PORT=3004 \
    TOKENS_DIR=/tokens \
    PROJECT_CONFIG_PATH=/project/project.json \
    NODE_ENV=production

CMD ["node", "dist/index.js"]
