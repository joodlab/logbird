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
- **body:** Two lists live here. **Releases** follow the repository's `CHANGELOG.md`: what changed in each version,
  and anything you must do to upgrade. The **build log** is a short post for each day of work, showing what we shipped
  with a real capture from the product.
- **status line:** Nothing has been released yet. Version 0.1 is in progress.
  <!-- source: CHANGELOG.md (all sections "Unreleased") -->
- **visual:** none

## releases

- **id:** `releases`
- **heading:** Releases
- **body:** Rendered from `CHANGELOG.md`. Each entry links to the pull requests it came from once the repository is
  public.
- **empty state (until the first release):** No releases yet. The first one, 0.1.0, will list everything since the
  start of the project.
- **visual:** none

## build-log

- **id:** `build-log`
- **heading:** Build log
- **body:** Day by day, in public. Drafts in `marketing/devlog/` are published here only after the owner approves
  them; each one becomes an entry in `apps/web/src/lib/publications.ts`.
- **empty state:** No entries yet. Each day's post appears here once it's published.
- **site:** the page is `ready` (indexed, in the footer and sitemap) from the first release or approved entry.
  <!-- source: marketing/README.md -->
- **visual:** each entry uses the still or clip named in its `post.md`

## how-we-write

- **id:** `how-we-write`
- **heading:** How entries are written (internal guidance, not shown on the page)
- **rules:**
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
