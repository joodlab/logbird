# Trailmark — agent guide

Read `docs/SPEC.md` first. `packages/contracts` is the API source of truth: server implements it, app consumes it.
If a contract must change, change it in the same PR and say so in the PR body.

## Stack & conventions (mirror `C:/Users/raedb/Desktop/Work/nibleaf`)
- pnpm 10 workspaces + turborepo, TypeScript 7, Biome/ultracite (`pnpm check`, `pnpm fix`), Vitest.
- Packages are named `@trailmark/<name>`, source-first exports (`"exports": {".": "./src/index.ts"}`).
- Server: Hono on `@hono/node-server`, zod 4 validation, `@t3-oss/env-core` for env, `tsx watch` in dev, `tsdown` build.
- DB: Prisma 7 + `@prisma/adapter-pg`. ClickHouse: `@clickhouse/client`. Queue: BullMQ on Dragonfly.
- Auth: better-auth (emailOTP + organization plugins). Email: react-email + nodemailer SMTP.
- App: TanStack Start + Router + Query + Table + Virtual + Form, Tailwind v4, shadcn (Base UI variant) in `packages/ui`.
  Copy patterns/components from nibleaf `packages/design-system` and `apps/app` rather than inventing new ones.
- Ports: app 4600, server 4601. The app proxies `/api` and `/v1` to the server in dev.

## Local services (never start your own Postgres/Redis/ClickHouse/Mailpit)
The owner runs shared containers. Namespace `trailmark` is provisioned:
Postgres DB `trailmark`, ClickHouse DB `trailmark`, Dragonfly logical DB 115 with BullMQ prefix `{trailmark}`,
Mailpit SMTP 127.0.0.1:1025 / UI http://127.0.0.1:8025. The root `.env` (gitignored) already holds the values;
packages load it with `dotenv -e ../../.env --`. Never print credentials, never FLUSHALL / drop other databases.
`./shared-local.ps1 <cmd>` runs a command with the shared env. `.env` is gitignored, so in a worktree first copy it:
`cp C:/Users/raedb/Desktop/Work/trailmark/.env <worktree>/.env`.

## Git workflow
- Repo: `github.com/joodlab/trailmark` (private). Default branch `master`. No CI workflows.
- Work on a feature branch in your own worktree under `C:/Users/raedb/AppData/Local/OpenAI/Codex/worktrees/`
  (`git worktree add <path> -b <branch> origin/master`). Keep PRs focused, rebase on `origin/master` before
  opening/updating, open a **ready (non-draft)** PR with a clear body (what/why/how verified). For UI PRs attach
  screenshots (and a short video when interaction matters) — commit them under `marketing/captures/<yyyy-mm-dd>-<pr-topic>/` (Git LFS) and
  reference them from the PR body.
- Commit messages: conventional (`feat(server): …`). End with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` only if you are a Claude agent.
- Do not merge your own PR; the orchestrator merges.

## Definition of done
`pnpm install && pnpm typecheck && pnpm check` pass for touched packages, tests pass, and the feature is proven
against the real local services (not mocks): include the commands/output or screenshots in the PR.
