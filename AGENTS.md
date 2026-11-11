# Logbird contributor and agent guide
Read docs/SPEC.md first. packages/contracts is the API source of truth; change contracts and implementations together and describe changes in the PR.

Use Node 22.18+ and pnpm 10.30.3. Packages use @logbird names and source-first exports. The stack is Hono, Prisma/Postgres, ClickHouse, BullMQ/Redis, better-auth and TanStack Start. Reuse packages/ui components.

See CONTRIBUTING.md for setup and checks. AGENTS.local.md may contain private machine-specific instructions and is gitignored. Never commit credentials or personal environment configuration. Preserve existing data and other contributors' changes.

Use focused feature branches, Conventional Commits, and ready-for-review PRs. Rebase on master before handoff. Include what/why/verification and screenshots or recordings for UI changes. Do not merge your own PR. GitHub Actions runs CI on pull requests and master pushes; releases are tag-driven. The manual Docker workflow builds (never pushes) the four release images and the marketing site image; PRs never trigger Docker builds; pushing a `v*` tag publishes multi-arch images to GHCR and creates the GitHub Release (see docs/releases.md).

Before handoff run pnpm install, pnpm typecheck, pnpm check, pnpm test and pnpm build. Prove service-dependent behavior against real services, using isolated fictional fixtures. Never reset a shared database.
