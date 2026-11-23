/**
 * The limits of retention and of the evidence export, in one place: the landing page's evidence table and the
 * compliance evidence page both render these, so the two can't drift apart. Brief, with the source of each sentence:
 * marketing/copy/use-cases/compliance-evidence.md. Maintainer rules: the deletion "starts right away" (not
 * "immediately"); a matching SHA-256 says nothing about the events before the export ran.
 */
export const evidenceLimits = {
  /** Who can shorten retention, what happens then, and what doesn't exist. */
  shortenRetention:
    'An owner or admin can shorten retention at any time, and the deletion starts right away. There is no retention lock or legal hold yet.',
  /** What a matching SHA-256 shows, and what it doesn't. */
  exportMatch:
    "Matching the file's SHA-256 and size to the export's completed record shows that the file you hold is the file Logbird produced for that export, not that the events were never changed before the export ran, and not who saved the file or when.",
} as const;
