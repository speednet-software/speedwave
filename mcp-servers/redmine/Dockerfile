
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS builder

WORKDIR /build

COPY tsconfig.base.json package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY redmine/package.json ./redmine/
RUN --mount=type=cache,target=/root/.npm npm ci --workspace=redmine --ignore-scripts

COPY shared/src ./shared/src
COPY shared/tsconfig.json ./shared/
RUN npm run build --workspace=shared

COPY redmine/src ./redmine/src
COPY redmine/tsconfig.json ./redmine/
RUN npm run build --workspace=redmine

RUN npm prune --omit=dev --workspace=redmine --ignore-scripts

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

RUN apk add --no-cache curl tzdata

WORKDIR /app

COPY --from=builder /build/shared/dist ./shared/dist
COPY --from=builder /build/shared/package.json ./shared/
COPY --from=builder /build/node_modules ./node_modules

COPY --from=builder /build/redmine/package.json ./
COPY --from=builder /build/redmine/dist ./dist

RUN mkdir -p /tokens /project && chown -R node:node /tokens /project /app

USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:3003/health || exit 1

EXPOSE 3003

ENV PORT=3003 \
    TOKENS_DIR=/tokens \
    PROJECT_CONFIG=/project/project.json \
    NODE_ENV=production

CMD ["node", "dist/index.js"]
