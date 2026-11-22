---
title: Changelog — Logbird
description: What changed in Logbird, release by release, plus the build log of what we shipped each day, with real captures.
path: /changelog
---

# Changelog and build log

## intro

- **id:** `intro`
- **eyebrow:** Changelog
- **heading (H1):** What changed, and when.
- **body:** Two lists live here. **Releases** are the versions published on GitHub, with the highlights from the
  repository's `CHANGELOG.md`; each links to its full notes and upgrade steps <!-- only once the repository is public -->. The
  **build log** holds short updates on what we shipped, with a capture from the product when there is one.
  <!-- source: CHANGELOG.md; the release list (apps/web/src/lib/releases.ts) -->
- **visual:** none

## releases

- **id:** `releases`
- **heading:** Releases
- **body:** <!-- copy-sync: skip (engineering note: how the list is built) --> One entry per GitHub Release (stable `vX.Y.Z`, published), newest first, with the `### Highlights`
  bullets of its `CHANGELOG.md` section and, once the repository is public, a link to its full release notes. The
  build reads the list from the GitHub API and falls back to `apps/web/src/lib/releases.snapshot.ts`; run
  `pnpm --filter @logbird/web releases:sync` after each release.
- **empty state (only when the release list is empty):** Nothing has been released yet. The first release will list
  everything since the start of the project. (Said once, here; there's no separate status line.)
- **visual:** none

## build-log

- **id:** `build-log`
- **heading:** Build log
- **body:** Day by day, in public. <!-- Drafts in `marketing/devlog/` are published here only after the owner approves
  them; each one becomes an entry in `apps/web/src/lib/publications.ts`. -->
- **empty state:** No entries yet. Each day's post appears here once it's published.
- **site:** the page is `ready` (indexed, in the footer and sitemap) from the first release or approved entry.
  <!-- source: marketing/README.md -->
- **visual:** each entry uses the still or clip named in its `post.md`

## how-we-write

- **id:** `how-we-write`
- **heading:** How entries are written (internal guidance, not shown on the page) <!-- copy-sync: skip (internal) -->
- **rules:** <!-- copy-sync: skip (internal writing guidance, not on the page) -->
  - **One change per entry, in the user's words.** "You can now search your audit log with SQL, safely." Not
    "Refactored query pipeline."
  - **Say the limit with the change.** "Live tail polls over HTTP; there's no WebSocket."
  - **Breaking changes and upgrade steps come first**, in their own block, with the command to run.
  - **Use real captures only**, from the real app against real services with fictional data.
  - **Numbers need a source.** No latency, throughput or customer numbers without a measurement report linked next
    to them. Today there are none, so entries have none.
  - **Release entries** use the Conventional Commit types: Added (`feat`), Fixed (`fix`), Changed, Security, Upgrade
    notes.
  - Don't name the design partner. Fictional data only: Lina Haddad, Azure Hotels, `bk_1042`, `@example.test`.
- **visual:** none
