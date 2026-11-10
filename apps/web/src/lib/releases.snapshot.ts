import type { Release } from './releases';

/**
 * The published releases as of the last `pnpm --filter @logbird/web releases:sync`. The build prefers the live GitHub
 * list and only falls back to this when GitHub can't be reached; refresh it after each release so that fallback, and
 * the tests, stay current. Generated: edit by re-running the sync, not by hand.
 */
export const snapshotReleases: Release[] = [
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
