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
    // A crop of the event-sheet capture above: the detail panel, at a size where its text is legible.
    id: 'event-detail',
    light: `${C}/event-detail-light.webp`,
    dark: `${C}/event-detail-dark.webp`,
    width: 639,
    height: 860,
    alt: 'One event in detail: the actor who caused it and the worker that performed it, the customer account, two target records, a status changed from pending to confirmed, and the request and its completion that caused it.',
  },
  {
    id: 'operation',
    light: `${C}/operation-light.webp`,
    dark: `${C}/operation-dark.webp`,
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
    dark: `${C}/sql-rejected-dark.webp`,
    ...desktop,
    alt: 'SQL mode rejecting a subquery before it runs, with the message that subqueries are not allowed.',
  },
  {
    id: 'query-suggestions',
    light: `${C}/query-suggestions-light.webp`,
    dark: `${C}/query-suggestions-dark.webp`,
    ...desktop,
    alt: 'The search bar suggesting values for the outcome field, with how many events have each value.',
  },
  {
    id: 'tenant',
    light: `${C}/tenant-light.webp`,
    dark: `${C}/tenant-dark.webp`,
    ...desktop,
    alt: "A tenant's page: event counts, how many events support did while signed in as the customer and by which agent, and the account's history with a chart and its events.",
  },
  {
    // A crop of the tenant capture above: the header, the counts and "who did it", at a size where the text reads.
    id: 'tenant-account',
    light: `${C}/tenant-account-light.webp`,
    width: 588,
    height: 414,
    alt: 'One customer account in the console: Dar Al Wafa Hotels had 428 events in the last 24 hours and 2,634 in all. Support agent Leena Ashford performed 5 of the 428 while signed in as the customer.',
  },
  {
    // The same panel from the 2026-11-24 tenant capture, light and dark, at its own size (tenant-account keeps master's).
    id: 'tenant-summary',
    light: `${C}/tenant-summary-light.webp`,
    dark: `${C}/tenant-summary-dark.webp`,
    width: 1160,
    height: 425,
    alt: 'One customer account in the console: Dar Al Wafa Hotels had 454 events in the last 24 hours and 2,632 in all. Support agent Leena Ashford performed 9 of the 454 while signed in as the customer.',
  },
  {
    id: 'actor',
    light: `${C}/actor-light.webp`,
    dark: `${C}/actor-dark.webp`,
    ...desktop,
    alt: "An actor's page for a person: event counts, what they did themselves and what support did as them, and their history with a chart and its events.",
  },
  {
    id: 'setup',
    light: `${C}/setup-light.webp`,
    dark: `${C}/setup-dark.webp`,
    ...desktop,
    alt: 'The setup page checking each part of the integration against the events received.',
  },
  {
    id: 'retention',
    light: `${C}/retention-light.webp`,
    dark: `${C}/retention-dark.webp`,
    ...desktop,
    alt: 'Retention settings showing the current retention window and available policies.',
  },
  {
    // The landing page's explorer, with a visible query that leaves out the scheduler's events.
    id: 'explorer-hero',
    light: `${C}/explorer-hero-light.webp`,
    dark: `${C}/explorer-hero-dark.webp`,
    ...desktop,
    // Above the fold on a phone, so captured at 2x.
    phone: { light: `${C}/phone-explorer-hero-light.webp`, dark: `${C}/phone-explorer-hero-dark.webp`, width: 780, height: 1688 },
    alt: 'The explorer with the query -actor.type:system: 9,415 events in the last seven days, a histogram, and a table of what people did.',
  },
  {
    // A real completed evidence export: the record's title above its raw payload's attributes (docs/media/README.md).
    id: 'export-record',
    light: `${C}/export-record-light.webp`,
    dark: `${C}/export-record-dark.webp`,
    width: 640,
    height: 847,
    phone: { light: `${C}/phone-export-record-light.webp`, dark: `${C}/phone-export-record-dark.webp`, ...phone },
    alt: "A completed export's record in Workspace activity: 3,157 events from StayDesk as Complete (original payloads), with its period, query action:booking.*, row count, size in bytes, fixed query clock, format and SHA-256.",
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
