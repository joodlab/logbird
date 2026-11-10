FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS prune
ARG NODE_OPTIONS
WORKDIR /source
RUN npm install --global pnpm@10.30.3 turbo@2.10.12
COPY . .
RUN turbo prune @logbird/web --docker

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
ARG NODE_OPTIONS
ARG BUILD_CONCURRENCY=1
ARG DOWNLOAD_CONCURRENCY=4
WORKDIR /workspace
RUN npm install --global pnpm@10.30.3
COPY --from=prune /source/out/json/ .
RUN pnpm install --frozen-lockfile --child-concurrency="$BUILD_CONCURRENCY" --network-concurrency="$DOWNLOAD_CONCURRENCY"
COPY --from=prune /source/out/full/ .
# Turbo prune excludes these build-time inputs; media and release notes read them from the repository root.
COPY --from=prune /source/marketing/media ./marketing/media
COPY --from=prune /source/docs/media ./docs/media
COPY --from=prune /source/CHANGELOG.md ./CHANGELOG.md
ARG WEB_SITE_URL
ARG WEB_APP_URL
ARG WEB_GITHUB_URL
ARG WEB_GITHUB_PUBLIC
ARG WEB_ORG_NAME
ARG WEB_SECURITY_EMAIL
ARG WEB_CONTACT_EMAIL
ARG WEB_PRIVACY_EMAIL
ARG WEB_LEGAL_ADDRESS
ARG WEB_GOVERNING_LAW
ARG WEB_HOSTING_PROVIDER
ARG WEB_EMAIL_PROVIDER
ARG WEB_MAILBOX_PROVIDER
# Empty optional arguments remain empty; siteConfigFrom treats them as unset and keeps its documented wording.
ENV WEB_SITE_URL=${WEB_SITE_URL}
ENV WEB_APP_URL=${WEB_APP_URL}
ENV WEB_GITHUB_URL=${WEB_GITHUB_URL}
ENV WEB_GITHUB_PUBLIC=${WEB_GITHUB_PUBLIC}
ENV WEB_ORG_NAME=${WEB_ORG_NAME}
ENV WEB_SECURITY_EMAIL=${WEB_SECURITY_EMAIL}
ENV WEB_CONTACT_EMAIL=${WEB_CONTACT_EMAIL}
ENV WEB_PRIVACY_EMAIL=${WEB_PRIVACY_EMAIL}
ENV WEB_LEGAL_ADDRESS=${WEB_LEGAL_ADDRESS}
ENV WEB_GOVERNING_LAW=${WEB_GOVERNING_LAW}
ENV WEB_HOSTING_PROVIDER=${WEB_HOSTING_PROVIDER}
ENV WEB_EMAIL_PROVIDER=${WEB_EMAIL_PROVIDER}
ENV WEB_MAILBOX_PROVIDER=${WEB_MAILBOX_PROVIDER}
RUN pnpm --workspace-concurrency="$BUILD_CONCURRENCY" --filter @logbird/web... build

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS runtime
WORKDIR /workspace
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4620 WAITLIST_FILE=/data/waitlist.jsonl
LABEL org.opencontainers.image.source="https://github.com/joodlab/logbird" org.opencontainers.image.licenses="MIT" org.opencontainers.image.title="Logbird site"
RUN mkdir /data && chown node:node /data
COPY --from=build --chown=node:node /workspace/apps/web/.output ./.output
USER node
EXPOSE 4620
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||"4620")+"/").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["node", ".output/server/index.mjs"]
