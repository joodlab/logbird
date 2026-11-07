/**
 * Real console captures shown on the site. Sources live in marketing/captures (Git LFS); scripts/media.ts encodes them.
 *
 * Every entry comes from the fictional "QA Azure Hotels" workspace (marketing/captures/2026-11-07-site-console/README.md).
 * Mark an entry `interim: true` when its capture still shows anything that may not be published (a real customer or
 * workspace name, a person's name, a timing). The Cloudflare build refuses to package while any entry is interim, and
 * every page is noindex + robots `Disallow: /` until then (see src/lib/release.ts).
 */
export interface Variant {
  light: string;
  dark?: string;
  width: number;
  height: number;
}
export interface ScreenshotEntry extends Variant {
  id: string;
  alt: string;
  /** A narrow capture served below 640px instead of a shrunken desktop one. */
  phone?: Variant;
  interim?: boolean;
}
export interface VideoEntry {
  id: string;
  src: string;
  poster: string;
  alt: string;
  interim?: boolean;
}

const C = 'marketing/captures/2026-11-07-site-console';
const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };

export const screenshots: ScreenshotEntry[] = [
  {
    id: 'explorer',
    light: `${C}/explorer-light.png`,
    dark: `${C}/explorer-dark.png`,
    ...desktop,
    phone: { light: `${C}/phone-explorer-light.png`, dark: `${C}/phone-explorer-dark.png`, ...phone },
    alt: 'The explorer filtered to booking actions: a histogram of the last seven days, facets for outcome, severity and action, and a table of events.',
  },
  {
    id: 'overview',
    light: `${C}/overview-light.png`,
    dark: `${C}/overview-dark.png`,
    ...desktop,
    alt: 'The overview: event, actor and tenant counts, failure rate, average conformance, events by outcome, and the top actions, actors, tenants and executors.',
  },
  {
    id: 'event-sheet',
    light: `${C}/event-sheet-light.png`,
    dark: `${C}/event-sheet-dark.png`,
    ...desktop,
    phone: { light: `${C}/phone-event-sheet-light.png`, dark: `${C}/phone-event-sheet-dark.png`, ...phone },
    alt: 'An event in detail: the actor and executor cards, the tenant, two target records, the status change from pending to confirmed, and the causation chain.',
  },
  {
    id: 'operation',
    light: `${C}/operation-light.png`,
    ...desktop,
    alt: 'An operation tree: a scheduler request, the worker jobs it started, two failed attempts and the retries that succeeded, each with its executor and attempt number.',
  },
  {
    id: 'sql',
    light: `${C}/sql-light.png`,
    dark: `${C}/sql-dark.png`,
    ...desktop,
    alt: "SQL mode with the expression job_attempt > 1 AND outcome = 'success', a histogram and the matching events.",
  },
  {
    id: 'sql-rejected',
    light: `${C}/sql-rejected-light.png`,
    ...desktop,
    alt: 'SQL mode rejecting a subquery before it runs, with the message that subqueries are not allowed.',
  },
  {
    id: 'query-suggestions',
    light: `${C}/query-suggestions-light.png`,
    ...desktop,
    alt: 'The search bar suggesting values for the outcome field, with how many events have each value.',
  },
  {
    id: 'tenant',
    light: `${C}/tenant-light.png`,
    ...desktop,
    alt: "A tenant's page: event counts, an activity chart, outcomes, top actions and the related actors, executors and records.",
  },
  {
    id: 'actor',
    light: `${C}/actor-light.png`,
    ...desktop,
    alt: "An actor's page for a scheduled job: event counts, activity, outcomes, top actions and related entities.",
  },
  {
    id: 'setup',
    light: `${C}/setup-light.png`,
    ...desktop,
    alt: 'The setup page checking each part of the integration against the events received.',
  },
  {
    id: 'retention',
    light: `${C}/retention-light.png`,
    ...desktop,
    alt: 'Retention settings while lowering the window to 30 days: a preview of how many events will be permanently deleted.',
  },
];

export const clips: VideoEntry[] = [
  {
    id: 'investigate',
    src: `${C}/investigate-explorer-operation.webm`,
    poster: `${C}/explorer-light.png`,
    alt: 'A query is typed into the explorer, an event is opened, and its operation tree is followed.',
  },
];

export const imageWidths = (width: number) => [...new Set([640, 1024, 1600].map((size) => Math.min(size, width)))];

/** Entries whose capture still needs replacing before a public build. */
export const interimMedia = () => [...screenshots.filter((entry) => entry.interim), ...clips.filter((clip) => clip.interim)].map((entry) => entry.id);
