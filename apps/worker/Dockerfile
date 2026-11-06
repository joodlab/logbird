FROM node:22-bookworm-slim AS prune
WORKDIR /source
RUN npm install --global pnpm@10.30.3 turbo@2.10.12
COPY . .
RUN turbo prune @logbird/worker --docker

FROM node:22-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@10.30.3 && apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=prune /source/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=prune /source/out/full/ .
ENV DATABASE_URL=postgresql://build:build@localhost:5432/logbird
RUN DATABASE_URL=postgresql://build:build@localhost:5432/logbird pnpm --filter @logbird/database generate
RUN pnpm --filter @logbird/worker... build

RUN pnpm --filter @logbird/worker deploy --legacy --prod /runtime
FROM node:22-bookworm-slim AS runtime
WORKDIR /workspace
ENV NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/joodlab/logbird"       org.opencontainers.image.licenses="MIT"       org.opencontainers.image.title="Logbird"
COPY --from=build --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/worker/dist ./dist
USER node
HEALTHCHECK --interval=30s --timeout=10s CMD node dist/health.mjs
CMD ["node", "dist/index.mjs"]
