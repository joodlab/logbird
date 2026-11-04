# Trailmark

Open-source (MIT), self-hostable audit log & activity history. Send any event from your product through the SDK
or HTTP API, keep it for as long as your project's retention says, and follow every user, tenant, worker and record
in a fast console built on ClickHouse.

- Spec: [`docs/SPEC.md`](docs/SPEC.md)
- Agent/contributor guide: [`AGENTS.md`](AGENTS.md)

```bash
pnpm install
pnpm db:deploy && pnpm ch:migrate
pnpm dev            # app http://localhost:4600 · server http://localhost:4601
pnpm seed           # StayDesk-shaped demo data; sign in as demo@trailmark.local (OTP in Mailpit :8025)
```
