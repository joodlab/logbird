# Open-source preparation review

Reviewed 2026-11-08. This change covers documentation and removal of three images.
It does not change application code, contracts, repository visibility, settings,
credentials or Git history.

## Removed and replaced

- Removed `docs/joodcms-starter/README.md` and its private-code patch,
  `docs/joodcms-starter/joodcms-logbird-starter.patch`.
- Replaced `docs/joodcms-integration.md` with
  [Integrating an existing backend](../integrating-a-backend.md), using generic
  SDK/HTTP examples, event modelling, redaction, stable event IDs and delivery limits.
- Rewrote the roadmap and removed private source comparisons from cloud operations.
- Replaced five workstation-specific command paths across three ingest-identity
  JSON receipts with equivalent `pnpm` or repository-relative commands. Historical
  results and timestamps are unchanged.
- Removed the private lock-file path and machine policy from the marketing README,
  and the private hosting-control-panel hostname from the decisions document.
- Updated Coolify and self-hosting instructions for public Git access, retaining
  private-fork authentication as an alternative.

## Tracked-text scan

Scanned tracked text except `pnpm-lock.yaml` for owner home paths, personal email
addresses, restricted account/project names, hostnames, IPv4 addresses and token
patterns. No personal email address or remaining owner home path was identified.
No restricted account/project name matched as a word. Gitleaks found no secrets
in the working tree. These checks do not inspect text inside images or videos.

Deliberately retained:

- Neutral `joodcms`/`joodbooking` source names and fictional hospitality demo data,
  including historical synthetic-data receipts. These do not provide private source.
- Reserved example domains, `.test`/`.local` fixture addresses, and synthetic email
  inputs used to test domain handling. `raed@example.com` is a reserved-domain query
  fixture. Business-address proposals in the brand document are not personal contacts
  and are not evidence of a working security mailbox.
- Localhost, loopback, private container addresses and Compose service names.
  `0.0.0.0` is a bind address; `6.6.6.6` is a deliberately spoofed header in the
  client-address test and its historical receipt, not a recorded customer address.
  Other dotted numeric matches are ClickHouse or browser version strings.
- Public upstream documentation/provider domains and the planned public service
  origin. Private network/listener terminology describes deployment boundaries.
- Package `private: true` flags prevent accidental npm publication; they do not
  describe repository visibility. Public agent instructions remain generic, and
  `AGENTS.local.md` remains ignored and untracked.

README, CONTRIBUTING, SECURITY, LICENSE, CODE_OF_CONDUCT and decisions were reviewed.
The MIT holder/year remains `2026 Joodlab`. Issue and PR templates already exist;
no templates or CI workflows were added.

## Image spot-check

Inspected these LFS images locally:

- `2026-11-04-final-polish/light-explorer-autocomplete.png`
- `2026-11-04-final-polish/dark-account.png`
- `2026-11-04-final-polish/dark-overview.png`
- `2026-11-07-a11y-explorer/before-create-key-dialog-phone-light.png`
- `2026-11-04-ui-foundation/real-keys.png`
- `2026-11-04-platform-foundation/otp-email.png`
- `2026-11-05-final-walkthrough/30-setup-read-key.png`
- `2026-11-05-walkthrough/30-setup-read-key.png`

Paths are under `marketing/captures/`. The first five show fictional demo data,
an empty creation dialog or masked key hints. The last three were removed: an old
sign-in OTP image and two setup images displaying complete read keys. Key validity
is unknown. The owner will handle the exposed local-dev keys; this change does
not revoke or rotate them. No secret value is reproduced in this report.
This was a spot-check, not an exhaustive media or video audit. Historical LFS
objects remain reachable.

## Verification and limits

- Main-checkout Biome binary: changed JSON files pass; Markdown is unsupported by
  Biome and was reviewed separately. Normalized edited text to LF.
- Edited JSON receipts parse. Checked 233 local Markdown file links: targets in
  changed documents resolve, and the tracked tree has no remaining links to the
  removed starter or old integration guide.
- `git diff --check`: passed.
- `gitleaks dir . --redact`: before updating from master, no findings. After
  incorporating merged PR #72, the final tree scan inspected approximately
  248.05 MB in 4.43 seconds and exited 1 with exactly three known false positives:
  API revision commit hashes in the exports-round5-waiting README and `apiRevision`
  fields in `after-proof.json` and `before-proof.json`. Each was checked against its
  source line. No credential finding was identified. A temporary configuration
  extends default rules and excludes only ignored dependency, Git-metadata, build
  and temporary directories; no tracked source is excluded. No suppression was
  added. This is a working-tree scan, not a new history scan.
- No files changed by PR #72 were edited, including `docs/SPEC.md`.
- Full installation attempts were stopped when available RAM dropped below the
  owner's threshold. The measured Node 22 attempt peaked at 1.000 GiB process-tree
  RSS; available memory fell from 8.048 to 4.966 GiB; minimum free disk was
  74.342 GiB. Its entire process tree was stopped. No services or browsers started.
- Per the orchestrator's explicit docs/images-only exception, full installation
  was not completed; `pnpm check`, typecheck, tests and build were not run because
  no code changed. The substitute checks above passed. No runtime behavior is
  claimed as verified.
- Cleanup review: no actionable slop found in the final documentation/image diff;
  no abstractions, dependencies or code changes were introduced.

New screenshots or a recording would not demonstrate these documentation and
image-removal changes. Source/link checks, the secret scan and this media review
provide the relevant evidence.

## Before changing visibility

The private-reporting API returned 404 during this review. SECURITY now links
directly to GitHub's private report form and describes a safe fallback, but an
enabled, working private reporting channel still needs owner verification.
Repository settings were not changed.

The owner must decide how to handle private code and exposed media in reachable
history before changing visibility. Preserving history is explicitly accepted
for opening this PR. These commits are returned by
`git log --all -- docs/joodcms-starter docs/joodcms-integration.md`:

- `1c84be85c0fbf3284a09da9545c79e74a3cbe8fe`: original integration plan and starter.
- `2bce2fad3aca828a4faee7ee29e667153c48130e`: renamed integration/starter material.

Relevant private paths are `docs/joodcms-integration.md`,
`docs/joodcms-starter/README.md` and
`docs/joodcms-starter/joodcms-logbird-starter.patch` (older names may differ).
The removed images also remain in historical commits, including
`49879b952f8292ff26d7e86c63731b75f8673241` and
`1d7934436bb425d3a735ffbd26b4b95a27c7ac69`.
