
FROM node:24-alpine@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0 AS builder

WORKDIR /build

COPY tsconfig.base.json package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY atlassian/package.json ./atlassian/
RUN --mount=type=cache,target=/root/.npm npm ci --workspace=atlassian --ignore-scripts

COPY shared/src ./shared/src
COPY shared/tsconfig.json ./shared/
RUN npm run build --workspace=shared

COPY atlassian/src ./atlassian/src
COPY atlassian/tsconfig.json ./atlassian/
RUN npm run build --workspace=atlassian

RUN npm prune --omit=dev --workspace=atlassian --ignore-scripts

FROM node:24-alpine@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0

RUN apk add --no-cache curl tzdata

WORKDIR /app

COPY --from=builder /build/shared/dist ./shared/dist
COPY --from=builder /build/shared/package.json ./shared/
COPY --from=builder /build/node_modules ./node_modules

COPY --from=builder /build/atlassian/package.json ./
COPY --from=builder /build/atlassian/dist ./dist

RUN mkdir -p /tokens /project && chown -R node:node /tokens /project /app

USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:3000/health || exit 1

EXPOSE 3000

ENV PORT=3000 \
    TOKENS_DIR=/tokens \
    PROJECT_CONFIG_PATH=/project/project.json \
    NODE_ENV=production

CMD ["node", "dist/index.js"]
