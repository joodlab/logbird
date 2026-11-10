# Architecture decisions

Decisions that shape self-hosting, releases and hosting. Each entry records the decision,
its implementation and remaining work. Newest first.

## 2026-11-08: public API reference, image registry, email provider, hosting

### API reference on the public origin ([#61](https://github.com/joodlab/logbird/issues/61))

The public origin (the console, `:4600`) **proxies read-only `GET /docs` and `GET /openapi.json`** to the private API
listener, without authentication, alongside `/api`, `/v1`, `/health`, `/livez` and `/readyz`. Only GET and HEAD are
forwarded (other methods get `405` from the console), and `Cookie`, `Authorization` and `Proxy-Authorization` are
stripped from those requests. Nothing else on the server becomes public: the allowlist in `apps/app/server/proxy-paths.ts` matches those paths exactly, and its tests
check that other paths (for example `/internal`, `/metrics`, `/docs/anything`) stay on the console. The same code
handles source development (Nitro middleware; there is deliberately no Vite dev proxy), the default Compose stack and the
Caddy profile (Caddy forwards the whole origin to the console).

The reference page runs on the console origin, so it loads a version-pinned Scalar bundle from jsDelivr with
Subresource Integrity, turns off Scalar telemetry, hosted fonts and the hosted AI agent, and gets a `/docs`-only CSP
whose `script-src` allows exactly that bundle URL plus Scalar's inline init script by hash, with `connect-src 'self'`. The API listener (`:4601`) itself stays private. See
[self-hosting](self-hosting.md#api-reference).

### Container image registry ([#88](https://github.com/joodlab/logbird/issues/88))

Role images are named **`ghcr.io/joodlab/logbird-<role>`** (`migrate`, `server`, `worker`, `app`).
`LOGBIRD_IMAGE_REGISTRY` defaults to `ghcr.io/joodlab`. The Docker Hub `logbird` namespace is not used.

**Update (v0.1.0, after open-sourcing):** the GHCR packages are public and published only by the tag-driven
release workflow (`v*` tags, multi-arch; see [releases](releases.md)). Pull requests build the images without
pushing. Both Compose files reference the published `${LOGBIRD_VERSION}` tag with `pull_policy: always`, so the
default install runs exactly the released images. Source builds go through `docker-compose.build.yml`, which uses
separate `logbird-source/<role>` names with `pull_policy: build`. A local build therefore never shadows a
published tag, and a published pull never replaces a local build. Fresh-install, upgrade and restore acceptance
on the target host is tracked in [#77](https://github.com/joodlab/logbird/issues/77).

### Transactional email: Postmark SMTP ([#59](https://github.com/joodlab/logbird/issues/59))

The hosted instance will send sign-in codes, invitations and membership notifications through **Postmark over SMTP**
(`smtp.postmarkapp.com:587`, STARTTLS required). The source now has `SMTP_REQUIRE_TLS=true`, which fails closed when
the server does not offer STARTTLS or the upgrade fails; its behaviour is tested against Mailpit. Code logging stays
off. Postmark setup (server token, SPF/DKIM/DMARC alignment, message streams, bounces and suppressions) is in
[transactional email](transactional-email.md#postmark). The live Postmark send, DNS alignment and receipt proof follow
with hosting; configure provider credentials and DNS as part of deployment.

### Hosting: Coolify behind Cloudflare, after open-sourcing

The hosted instance is planned on Coolify behind Cloudflare at `logbird.joodlab.com` after the repository is open-sourced. Provisioning and deployment remain separate steps. Follow [Coolify](coolify.md) with
`APP_URL=https://audit.example.com` (replace with your public origin). `TRUST_PROXY` must be set from the verified proxy chain at that time (Cloudflare
in front of Coolify's proxy adds a hop only if Coolify's proxy is configured to trust Cloudflare's forwarding headers);
verify the recorded client address before relying on per-client limits. The Kubernetes/Hetzner material in [cloud operations](cloud-operations.md)
remains design work and is not the chosen launch path.
