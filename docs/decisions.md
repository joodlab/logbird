# Owner decisions

Decisions the repository owner made that shape self-hosting, releases and hosting. Each entry says what was decided,
what the source implements now and what still waits for a later step. Newest first.

## 2026-11-08: public API reference, image registry, email provider, hosting

### API reference on the public origin ([#61](https://github.com/joodlab/logbird/issues/61))

The public origin (the console, `:4600`) **proxies read-only `GET /docs` and `GET /openapi.json`** to the private API
listener, without authentication, alongside `/api`, `/v1`, `/health`, `/livez` and `/readyz`. Only GET and HEAD are
forwarded (other methods get `405` from the console), and `Cookie`, `Authorization` and `Proxy-Authorization` are
stripped from those requests. Nothing else on the server becomes public: the allowlist in `apps/app/server/proxy-paths.ts` matches those paths exactly, and its tests
check that other paths (for example `/internal`, `/metrics`, `/docs/anything`) stay on the console. The same code
handles source development (Nitro middleware; the Vite dev proxy covers only `/api` and `/v1`), the default Compose stack and the
Caddy profile (Caddy forwards the whole origin to the console).

The reference page runs on the console origin, so it loads a version-pinned Scalar bundle from jsDelivr with
Subresource Integrity, turns off Scalar telemetry, hosted fonts and the hosted AI agent, and gets a `/docs`-only CSP
that allows that one script host and `connect-src 'self'`. The API listener (`:4601`) itself stays private. See
[self-hosting](self-hosting.md#api-reference).

### Container image registry ([#88](https://github.com/joodlab/logbird/issues/88))

Role images are named **`ghcr.io/joodlab/logbird-<role>`** (`migrate`, `server`, `worker`, `app`).
`LOGBIRD_IMAGE_REGISTRY` defaults to `ghcr.io/joodlab`. **Nothing is published until the repository is open-sourced**,
and each publication still needs explicit owner approval. No CI workflow builds or pushes images.

Source installs build these names locally and never pull a runnable role implicitly: the four roles keep
`pull_policy: build`, so bare `up` builds from the checkout and `up --no-build` with a missing image fails. Only the documented release flow pulls, explicitly, an accepted version. The Docker Hub
`logbird` namespace was never verified as owner-controlled and is no longer the default. The local Compose runtime
matrix is recorded in [verification/compose-pull-policy-2026-11-08.md](verification/compose-pull-policy-2026-11-08.md).
A live fresh install, upgrade and restore on the real host follows after open-sourcing.

### Transactional email: Postmark SMTP ([#59](https://github.com/joodlab/logbird/issues/59))

Hosted Logbird sends sign-in codes, invitations and membership notifications through **Postmark over SMTP**
(`smtp.postmarkapp.com:587`, STARTTLS required). The source now has `SMTP_REQUIRE_TLS=true`, which fails closed when
the server does not offer STARTTLS or the upgrade fails; its behaviour is tested against Mailpit. Code logging stays
off. Postmark setup (server token, SPF/DKIM/DMARC alignment, message streams, bounces and suppressions) is in
[transactional email](transactional-email.md#postmark). The live Postmark send, DNS alignment and receipt proof follow
with hosting; no Postmark account, token or DNS record was created or changed here.

### Hosting: Coolify behind Cloudflare, after open-sourcing

The hosted instance will run on **Coolify (`coolify.joodlab.com`) behind Cloudflare at `logbird.joodlab.com`**, after
the repository is open-sourced. This is a recorded decision only. No Coolify resource, Cloudflare setting, DNS record
or account was created or changed. The deployment will follow [Coolify](coolify.md) with
`APP_URL=https://logbird.joodlab.com`. `TRUST_PROXY` must be set from the verified proxy chain at that time (Cloudflare
in front of Coolify's proxy adds a hop only if Coolify's proxy is configured to trust Cloudflare's forwarding headers);
verify the recorded client address before relying on per-client limits. The Kubernetes/Hetzner material in [cloud operations](cloud-operations.md)
remains design work and is not the chosen launch path.
