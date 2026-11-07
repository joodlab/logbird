/**
 * Phrases that say the source isn't public yet. Every one must sit behind a GITHUB_PUBLIC gate:
 * scripts/check-source-state.ts fails a public build that still renders any of them, and the tests check the data
 * modules in both states.
 */
export const SOURCE_STATE_PHRASES = [
  'coming soon',
  'opens publicly soon',
  'source opens soon',
  'when the source opens',
  'once the source opens',
  'repository opens',
  'repository is public',
  "isn't public",
  "you'll be able to self-host",
] as const;

/**
 * Phrases that say the source is already open. The mirror of the list above: scripts/check-source-state.ts fails a
 * private build (WEB_GITHUB_PUBLIC unset) that renders any of them.
 */
export const SOURCE_OPEN_PHRASES = [
  'released it under',
  'Self-host Logbird today',
  'Self-host it',
  'today, self-host Logbird',
  'codebase you can self-host',
  'source on GitHub',
  'repository on GitHub',
  'Source on GitHub, under',
] as const;
