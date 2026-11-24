
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS builder

WORKDIR /build

COPY tsconfig.base.json package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY slack/package.json ./slack/
RUN --mount=type=cache,target=/root/.npm npm ci --workspace=slack --ignore-scripts

COPY shared/src ./shared/src
COPY shared/tsconfig.json ./shared/
RUN npm run build --workspace=shared

COPY slack/src ./slack/src
COPY slack/tsconfig.json ./slack/
RUN npm run build --workspace=slack

RUN npm prune --omit=dev --workspace=slack --ignore-scripts

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

RUN apk add --no-cache curl tzdata

WORKDIR /app

COPY --from=builder /build/shared/dist ./shared/dist
COPY --from=builder /build/shared/package.json ./shared/
COPY --from=builder /build/node_modules ./node_modules

COPY --from=builder /build/slack/package.json ./
COPY --from=builder /build/slack/dist ./dist

RUN mkdir -p /tokens && chown -R node:node /tokens /app

USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:3001/health || exit 1

EXPOSE 3001

ENV PORT=3001 \
    TOKENS_DIR=/tokens \
    NODE_ENV=production

CMD ["node", "dist/index.js"]
