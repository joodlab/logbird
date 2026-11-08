FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS prune
ARG NODE_OPTIONS
WORKDIR /source
RUN npm install --global pnpm@10.30.3 turbo@2.10.12
COPY . .
RUN turbo prune @logbird/app --docker

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
ENV DATABASE_URL=postgresql://build:build@localhost:5432/logbird
# Console has no database client generation step.
RUN pnpm --workspace-concurrency="$BUILD_CONCURRENCY" --filter @logbird/app... build
# Distroless has no shell: append the unprivileged `node` user (uid/gid 1000, as before) to its account files.
COPY --from=base /etc/passwd /etc/group /rootfs/etc/
RUN echo 'node:x:1000:1000:node:/home/node:/sbin/nologin' >> /rootfs/etc/passwd \
  && echo 'node:x:1000:' >> /rootfs/etc/group \
  && mkdir -p /rootfs/home/node

# Shell-free glibc runtime (Debian 12 = bookworm) with the build stage's exact Node binary; no package manager.
# Nitro's .output is already a traced, self-contained server.
FROM base AS runtime
COPY --from=build /rootfs/etc/passwd /rootfs/etc/group /etc/
COPY --from=build --chown=1000:1000 /rootfs/home/node /home/node
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /workspace/apps/app/.output /workspace/.output
WORKDIR /workspace
ENV NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/joodlab/logbird"       org.opencontainers.image.licenses="MIT"       org.opencontainers.image.title="Logbird"
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'4600')+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", ".output/server/index.mjs"]
