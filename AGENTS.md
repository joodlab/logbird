# Logbird contributor and agent guide
Read docs/SPEC.md first. packages/contracts is the API source of truth; change contracts and implementations together and describe changes in the PR.

Use Node 22.18+ and pnpm 10.30.3. Packages use @logbird names and source-first exports. The stack is Hono, Prisma/Postgres, ClickHouse, BullMQ/Redis, better-auth and TanStack Start. Reuse packages/ui components.

See CONTRIBUTING.md for setup and checks. AGENTS.local.md may contain private machine-specific instructions and is gitignored. Never commit credentials or personal environment configuration. Preserve existing data and other contributors' changes.

Use focused feature branches, Conventional Commits, and ready-for-review PRs. Rebase on master before handoff. Include what/why/verification and screenshots or recordings for UI changes. Do not merge your own PR. Do not add CI workflows or automatic Docker builds; release checks are manual.

Before handoff run pnpm install, pnpm typecheck, pnpm check, pnpm test and pnpm build. Prove service-dependent behavior against real services, using isolated fictional fixtures. Never reset a shared database.
