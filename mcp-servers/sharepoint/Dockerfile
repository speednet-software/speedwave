
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS builder

WORKDIR /build

COPY tsconfig.base.json ./
COPY shared/package*.json ./shared/
RUN --mount=type=cache,target=/root/.npm cd shared && npm install

COPY shared/src ./shared/src
COPY shared/tsconfig.json ./shared/
RUN cd shared && npm run build

COPY sharepoint/package*.json ./sharepoint/
RUN --mount=type=cache,target=/root/.npm cd sharepoint && npm install

COPY sharepoint/src ./sharepoint/src
COPY sharepoint/tsconfig.json ./sharepoint/
RUN cd sharepoint && npm run build

RUN cd sharepoint && npm prune --omit=dev

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4

RUN apk add --no-cache curl tzdata

WORKDIR /app

COPY --from=builder /build/shared/dist ../shared/dist
COPY --from=builder /build/shared/package.json ../shared/
COPY --from=builder /build/shared/node_modules ../shared/node_modules

COPY --from=builder /build/sharepoint/package*.json ./
COPY --from=builder /build/sharepoint/dist ./dist
COPY --from=builder /build/sharepoint/node_modules ./node_modules

RUN mkdir -p /tokens && chown -R node:node /tokens /app /app/../shared

USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:3002/health || exit 1

EXPOSE 3002

ENV PORT=3002 \
    TOKENS_DIR=/tokens \
    NODE_ENV=production

CMD ["node", "dist/index.js"]
