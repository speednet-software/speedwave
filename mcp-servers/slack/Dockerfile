
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS builder

WORKDIR /build

COPY tsconfig.base.json ./
COPY shared/package*.json ./shared/
RUN --mount=type=cache,target=/root/.npm cd shared && npm install

COPY shared/src ./shared/src
COPY shared/tsconfig.json ./shared/
RUN cd shared && npm run build

COPY slack/package*.json ./slack/
RUN --mount=type=cache,target=/root/.npm cd slack && npm install

COPY slack/src ./slack/src
COPY slack/tsconfig.json ./slack/
RUN cd slack && npm run build

RUN cd slack && npm prune --omit=dev

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4

RUN apk add --no-cache curl tzdata

WORKDIR /app

COPY --from=builder /build/shared/dist ../shared/dist
COPY --from=builder /build/shared/package.json ../shared/
COPY --from=builder /build/shared/node_modules ../shared/node_modules

COPY --from=builder /build/slack/package*.json ./
COPY --from=builder /build/slack/dist ./dist
COPY --from=builder /build/slack/node_modules ./node_modules

RUN mkdir -p /tokens && chown -R node:node /tokens /app /app/../shared

USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:3001/health || exit 1

EXPOSE 3001

ENV PORT=3001 \
    TOKENS_DIR=/tokens \
    NODE_ENV=production

CMD ["node", "dist/index.js"]
