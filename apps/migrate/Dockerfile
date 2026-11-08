# One-shot migration image: Prisma CLI + PostgreSQL schema/migrations, and the bundled ClickHouse
# migration and restricted query-user provisioning scripts. Build from the repository root:
#   docker compose build migrate   (or: docker build -f apps/migrate/Dockerfile .)
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS prune
ARG NODE_OPTIONS
WORKDIR /source
RUN npm install --global pnpm@10.30.3 turbo@2.10.12
COPY . .
RUN turbo prune @logbird/migrate --docker

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
ARG NODE_OPTIONS
ARG BUILD_CONCURRENCY=1
ARG DOWNLOAD_CONCURRENCY=4
WORKDIR /workspace
RUN npm install --global pnpm@10.30.3 && apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=prune /source/out/json/ .
RUN pnpm install --frozen-lockfile --child-concurrency="$BUILD_CONCURRENCY" --network-concurrency="$DOWNLOAD_CONCURRENCY"
COPY --from=prune /source/out/full/ .
# Bundles the ClickHouse scripts (with @clickhouse/client) and prisma.config (with its env validation).
RUN pnpm --filter @logbird/migrate build
# Prisma CLI and its declared dependency closure only. `typescript` is an optional peer of prisma that the
# lockfile resolves from the workspace; the bundled prisma.config.mjs needs no compiler, so it is removed.
RUN pnpm --child-concurrency="$BUILD_CONCURRENCY" --network-concurrency="$DOWNLOAD_CONCURRENCY" --filter @logbird/migrate deploy --legacy --prod /deploy \
  && rm -rf /deploy/node_modules/typescript /deploy/node_modules/@typescript /deploy/node_modules/.bin
RUN mkdir -p /image/packages/database /image/packages/clickhouse \
  && mv /deploy/node_modules /image/node_modules \
  && cp -r packages/database/prisma /image/packages/database/prisma \
  && cp apps/migrate/dist/database/prisma.config.mjs /image/packages/database/prisma.config.mjs \
  && cp -r apps/migrate/dist/clickhouse /image/packages/clickhouse/dist \
  && cp -r packages/clickhouse/migrations /image/packages/clickhouse/migrations

# Fresh Debian base: Node's binary only (no npm, corepack, yarn or pnpm), plus the OpenSSL runtime the
# Prisma schema engine links against and tini for signal forwarding to the migration process group.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS migrate
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl tini && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1000 node && useradd --uid 1000 --gid node --shell /bin/sh --create-home node
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /image /workspace
RUN ln -s /workspace/node_modules/prisma/build/index.js /usr/local/bin/prisma
ENV NODE_ENV=production
WORKDIR /workspace/packages/database
LABEL org.opencontainers.image.source="https://github.com/joodlab/logbird" org.opencontainers.image.licenses="MIT" org.opencontainers.image.title="Logbird migrations"
USER node
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["sh", "-c", "prisma migrate deploy && cd ../clickhouse && node dist/migrate.mjs && exec node dist/create-query-user.mjs"]
