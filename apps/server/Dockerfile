FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS prune
ARG NODE_OPTIONS
WORKDIR /source
RUN npm install --global pnpm@10.30.3 turbo@2.10.12
COPY . .
RUN turbo prune @logbird/server --docker

FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build
ARG NODE_OPTIONS
ARG BUILD_CONCURRENCY=1
ARG DOWNLOAD_CONCURRENCY=4
WORKDIR /workspace
RUN npm install --global pnpm@10.30.3 && apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=prune /source/out/json/ .
RUN pnpm install --frozen-lockfile --child-concurrency="$BUILD_CONCURRENCY" --network-concurrency="$DOWNLOAD_CONCURRENCY"
COPY --from=prune /source/out/full/ .
ENV DATABASE_URL=postgresql://build:build@localhost:5432/logbird
RUN DATABASE_URL=postgresql://build:build@localhost:5432/logbird pnpm --filter @logbird/database generate
RUN pnpm --workspace-concurrency="$BUILD_CONCURRENCY" --filter @logbird/server... build

RUN pnpm --child-concurrency="$BUILD_CONCURRENCY" --network-concurrency="$DOWNLOAD_CONCURRENCY" --filter @logbird/server deploy --legacy --prod /runtime

# Copy installed tooling into a fresh image: the build stage also contains the
# package store, compiler caches and the deployed API dependency tree.
FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS migrate
WORKDIR /workspace
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/lib/node_modules/pnpm /usr/local/lib/node_modules/pnpm
RUN ln -s /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/packages ./packages
COPY --from=build --chown=node:node /workspace/apps ./apps
COPY --from=build /workspace/package.json /workspace/pnpm-workspace.yaml ./
LABEL org.opencontainers.image.source="https://github.com/joodlab/logbird" org.opencontainers.image.licenses="MIT" org.opencontainers.image.title="Logbird migrations"
USER node
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["sh", "-c", "pnpm --filter @logbird/database migrate:deploy && pnpm --filter @logbird/clickhouse migrate && cd packages/clickhouse && exec node --import tsx scripts/create-query-user.ts"]

FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS runtime
WORKDIR /workspace
ENV NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/joodlab/logbird"       org.opencontainers.image.licenses="MIT"       org.opencontainers.image.title="Logbird"
COPY --from=build --chown=node:node /runtime/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/server/dist ./dist
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||"4601")+"/livez").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["node", "dist/index.mjs"]
