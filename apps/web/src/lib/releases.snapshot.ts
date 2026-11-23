import type { Release } from './releases';

/**
 * The published releases as of the last `pnpm --filter @logbird/web releases:sync`. The build prefers the live GitHub
 * list and only falls back to this when GitHub can't be reached; refresh it after each release so that fallback, and
 * the tests, stay current. Generated: edit by re-running the sync, not by hand.
 */
export const snapshotReleases: Release[] = [
  {
    version: '0.2.1',
    date: '2026-11-22',
    highlights: [
      'Jump to (Ctrl K) finds an entity by its id: the exact id leads the list, a record is found by its bare id (`article_27_2` for `article:article_27_2`), and "Search events for" runs the id query instead of free text.',
      'For a recognized entity ID entered as a single free-text term, the explorer\'s empty state offers the ID query. Otherwise, it offers "Search all time" when the all-time check finds matches outside the selected range.',
      'The console forwards `/pricing` and `/use-cases` to the marketing site when one is configured.',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-11-22',
    highlights: [
      "Show each customer only its own audit trail: tenant-scoped read keys and short-lived viewer tokens (15 minutes by default) read one tenant's (or one record's) events through search, event detail, counts grouped by a field and export. The server enforces the scope, and ClickHouse enforces the tenant as well when the restricted query user is configured.",
      "Stored events are exact: 64-bit ids and long decimals keep every digit, a record's history matches its type and id on the same target, and a slow total count no longer fails a search.",
      'Breaking for some saved queries and API filters: `record:` now selects one record (to search a custom attribute named `record`, write `attr.record:`), `\\*` and `\\r` are now escapes, and numeric attribute values are indexed under one spelling. Read the Breaking changes section of CHANGELOG.md for 0.2.0 before upgrading.',
    ],
  },
  {
    version: '0.1.3',
    date: '2026-11-22',
    highlights: [
      'The first published release that carries the 0.1.2 changes. 0.1.2 was tagged, but its server, worker and migrate images were never published and it has no GitHub Release; upgrade from 0.1.1 straight to 0.1.3 with the upgrade notes.',
      'Release images for arm64 are now built on native runners, and a published version is checked to contain both linux/amd64 and linux/arm64 before the `latest` and `0.1` tags move to it.',
    ],
  },
  {
    version: '0.1.1',
    date: '2026-11-10',
    highlights: [
      "Serve the Logbird website on the console's origin: set `LOGBIRD_SITE_URL` and signed-out visitors get the site while signed-in users keep the console; self-hosted installs are unchanged.",
      'Generate release notes with changelogithub, with a Breaking changes section and a strict human-only contributor list that never credits AI agents or bots.',
      "Publish a privacy policy and terms of service for Logbird Cloud's early access; the access form links them and accepts privacy requests.",
    ],
  },
  {
    version: '0.1.0',
    date: '2026-11-09',
    highlights: [
      'Capture activity with the event ingest API and TypeScript SDK, including batching, retries and immutable event IDs.',
      'Search and follow live events in the console, inspect actors and targets, export results, and enforce project retention.',
      'Self-host with Compose or Coolify using versioned images, SMTP sign-in and restricted signups for your team.',
    ],
  },
];
