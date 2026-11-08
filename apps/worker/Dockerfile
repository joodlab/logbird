FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS prune
ARG NODE_OPTIONS
WORKDIR /source
RUN npm install --global pnpm@10.30.3 turbo@2.10.12
COPY . .
RUN turbo prune @logbird/worker --docker

FROM gcr.io/distroless/cc-debian12@sha256:e5d81ddde149641e2a9ba55be4545bc125c67de07508b03ba4c22e6eb0ded5aa AS base

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
ARG NODE_OPTIONS
ARG BUILD_CONCURRENCY=1
ARG DOWNLOAD_CONCURRENCY=4
WORKDIR /workspace
RUN npm install --global pnpm@10.30.3 && apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=prune /source/out/json/ .
RUN pnpm install --frozen-lockfile --child-concurrency="$BUILD_CONCURRENCY" --network-concurrency="$DOWNLOAD_CONCURRENCY"
COPY --from=prune /source/out/full/ .
COPY --from=prune /source/scripts/trace-runtime.mjs scripts/trace-runtime.mjs
ENV DATABASE_URL=postgresql://build:build@localhost:5432/logbird
RUN DATABASE_URL=postgresql://build:build@localhost:5432/logbird pnpm --filter @logbird/database generate
RUN pnpm --workspace-concurrency="$BUILD_CONCURRENCY" --filter @logbird/worker... build
# The entrypoints already bundle @logbird/* and their third-party code; copy only the files they load.
# bullmq/ioredis CommonJS entries are traced too, so the documented `exec worker node -e 'require("bullmq")'`
# recovery command keeps working.
RUN node scripts/trace-runtime.mjs /runtime apps/worker/dist/index.mjs apps/worker/dist/health.mjs
# Distroless has no shell: append the unprivileged `node` user (uid/gid 1000, as before) to its account files.
COPY --from=base /etc/passwd /etc/group /rootfs/etc/
RUN echo 'node:x:1000:1000:node:/home/node:/sbin/nologin' >> /rootfs/etc/passwd \
  && echo 'node:x:1000:' >> /rootfs/etc/group \
  && mkdir -p /rootfs/home/node

# Shell-free glibc runtime (Debian 12 = bookworm) with the build stage's exact Node binary; no package manager.
FROM base AS runtime
COPY --from=build /rootfs/etc/passwd /rootfs/etc/group /etc/
COPY --from=build --chown=1000:1000 /rootfs/home/node /home/node
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /runtime/ /workspace/
WORKDIR /workspace/apps/worker
ENV NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/joodlab/logbird"       org.opencontainers.image.licenses="MIT"       org.opencontainers.image.title="Logbird"
USER node
HEALTHCHECK --interval=30s --timeout=10s CMD ["node", "dist/health.mjs"]
CMD ["node", "dist/index.mjs"]
