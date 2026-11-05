FROM node:22-bookworm-slim AS prune
WORKDIR /source
RUN npm install --global pnpm@10.30.3 turbo@2.10.12
COPY . .
RUN turbo prune @trailmark/app --docker

FROM node:22-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@10.30.3 && apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=prune /source/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=prune /source/out/full/ .
ARG TRAILMARK_SERVER_URL=http://server:4601
ENV TRAILMARK_SERVER_URL=$TRAILMARK_SERVER_URL
ENV DATABASE_URL=postgresql://build:build@localhost:5432/trailmark
# Console has no database client generation step.
RUN pnpm --filter @trailmark/app... build

FROM node:22-bookworm-slim AS runtime
WORKDIR /workspace
RUN npm install --global pnpm@10.30.3 && apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build --chown=node:node /workspace /workspace
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||"4600")+"/").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["node", "apps/app/.output/server/index.mjs"]
