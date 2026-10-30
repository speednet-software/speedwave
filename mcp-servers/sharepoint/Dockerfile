
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder

WORKDIR /build

COPY tsconfig.base.json package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY sharepoint/package.json ./sharepoint/
RUN --mount=type=cache,target=/root/.npm npm ci --workspace=sharepoint --ignore-scripts

COPY shared/src ./shared/src
COPY shared/tsconfig.json ./shared/
RUN npm run build --workspace=shared

COPY sharepoint/src ./sharepoint/src
COPY sharepoint/tsconfig.json ./sharepoint/
RUN npm run build --workspace=sharepoint

RUN npm prune --omit=dev --workspace=sharepoint --ignore-scripts

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

RUN apk add --no-cache curl tzdata

WORKDIR /app

COPY --from=builder /build/shared/dist ./shared/dist
COPY --from=builder /build/shared/package.json ./shared/
COPY --from=builder /build/node_modules ./node_modules

COPY --from=builder /build/sharepoint/package.json ./
COPY --from=builder /build/sharepoint/dist ./dist

RUN mkdir -p /tokens && chown -R node:node /tokens /app

USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:3002/health || exit 1

EXPOSE 3002

ENV PORT=3002 \
    TOKENS_DIR=/tokens \
    NODE_ENV=production

CMD ["node", "dist/index.js"]
