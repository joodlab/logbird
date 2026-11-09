/** Reviewed real-service captures of the fictional Acme / StayDesk fixture. See docs/media/README.md. */
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

const C = 'marketing/media/staydesk';
const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };

export const screenshots: ScreenshotEntry[] = [
  {
    id: 'explorer',
    light: `${C}/explorer-light.webp`,
    dark: `${C}/explorer-dark.webp`,
    ...desktop,
    phone: { light: `${C}/phone-explorer-light.webp`, dark: `${C}/phone-explorer-dark.webp`, ...phone },
    alt: 'The explorer filtered to booking actions: a histogram of the last seven days, facets for outcome, severity and action, and a table of events.',
  },
  {
    id: 'overview',
    light: `${C}/overview-light.webp`,
    dark: `${C}/overview-dark.webp`,
    ...desktop,
    alt: 'The overview: event, actor and tenant counts, failure rate, average conformance, events by outcome, and the top actions, actors, tenants and executors.',
  },
  {
    id: 'event-sheet',
    light: `${C}/event-sheet-light.webp`,
    dark: `${C}/event-sheet-dark.webp`,
    ...desktop,
    phone: { light: `${C}/phone-event-sheet-light.webp`, dark: `${C}/phone-event-sheet-dark.webp`, ...phone },
    alt: 'An event in detail: the actor and executor cards, the tenant, two target records, before/after field changes, and the causation chain.',
  },
  {
    id: 'operation',
    light: `${C}/operation-light.webp`,
    ...desktop,
    alt: 'An operation tree: a scheduler request, the worker jobs it started, two failed attempts and the retries that succeeded, each with its executor and attempt number.',
  },
  {
    id: 'sql',
    light: `${C}/sql-light.webp`,
    dark: `${C}/sql-dark.webp`,
    ...desktop,
    alt: "SQL mode with the expression job_attempt > 1 AND outcome = 'success', a histogram and the matching events.",
  },
  {
    id: 'sql-rejected',
    light: `${C}/sql-rejected-light.webp`,
    ...desktop,
    alt: 'SQL mode rejecting a subquery before it runs, with the message that subqueries are not allowed.',
  },
  {
    id: 'query-suggestions',
    light: `${C}/query-suggestions-light.webp`,
    ...desktop,
    alt: 'The search bar suggesting values for the outcome field, with how many events have each value.',
  },
  {
    id: 'tenant',
    light: `${C}/tenant-light.webp`,
    ...desktop,
    alt: "A tenant's page: event counts, an activity chart, outcomes, top actions and the related actors, executors and records.",
  },
  {
    id: 'actor',
    light: `${C}/actor-light.webp`,
    ...desktop,
    alt: "An actor's page for a scheduled job: event counts, activity, outcomes, top actions and related entities.",
  },
  {
    id: 'setup',
    light: `${C}/setup-light.webp`,
    ...desktop,
    alt: 'The setup page checking each part of the integration against the events received.',
  },
  {
    id: 'retention',
    light: `${C}/retention-light.webp`,
    ...desktop,
    alt: 'Retention settings showing the current retention window and available policies.',
  },
];

export const clips: VideoEntry[] = [
  {
    id: 'investigate',
    src: 'docs/media/walkthrough.webm',
    poster: `${C}/explorer-light.webp`,
    alt: 'Sign in, explore StayDesk events, inspect changes, and watch live bookings arrive.',
  },
];

export const imageWidths = (width: number) => [...new Set([640, 1024, 1600].map((size) => Math.min(size, width)))];

/** Entries whose capture still needs replacing before a public build. */
export const interimMedia = () => [...screenshots.filter((entry) => entry.interim), ...clips.filter((clip) => clip.interim)].map((entry) => entry.id);
