export interface ScreenshotEntry {
  id: string;
  light: string;
  dark?: string;
  alt: string;
  width: number;
  height: number;
}
export interface VideoEntry {
  id: string;
  src: string;
  poster: string;
  alt: string;
}
export const screenshots: ScreenshotEntry[] = [
  {
    id: 'explorer',
    light: 'marketing/captures/2026-11-06-logbird-rename/04-explorer-light.png',
    dark: 'marketing/captures/2026-11-06-logbird-rename/05-explorer-dark.png',
    alt: 'The event explorer shows a timeline histogram, filters and a table of audit events.',
    width: 1280,
    height: 800,
  },
  {
    id: 'overview',
    light: 'marketing/captures/2026-11-06-logbird-rename/03-overview-light.png',
    dark: 'marketing/captures/2026-11-06-logbird-rename/06-overview-dark.png',
    alt: 'The overview shows an integration checklist, event summary cards and an empty outcome chart.',
    width: 1280,
    height: 800,
  },
  {
    id: 'event-sheet',
    light: 'marketing/captures/2026-11-05-final-walkthrough/04-event-sheet.png',
    dark: 'marketing/captures/2026-11-05-final-walkthrough/13-dark-event-sheet.png',
    alt: 'An event detail sheet shows an audit event alongside the event explorer.',
    width: 1440,
    height: 900,
  },
  {
    id: 'operation',
    light: 'marketing/captures/2026-11-05-final-walkthrough/05-operation.png',
    alt: 'The operation page shows a failed delivery event and its operation summary.',
    width: 1440,
    height: 900,
  },
  {
    id: 'sql',
    light: 'marketing/captures/2026-11-05-final-walkthrough/qb-22-sql-results.png',
    dark: 'marketing/captures/2026-11-05-final-walkthrough/qb-28-dark-sql.png',
    alt: 'The explorer shows a SQL query above a histogram and a table of matching events.',
    width: 1440,
    height: 900,
  },
  {
    id: 'retention',
    light: 'marketing/captures/2026-11-05-final-walkthrough/10-retention-preview.png',
    alt: 'Retention settings show a shorter retention window and a warning about permanent event deletion.',
    width: 1440,
    height: 900,
  },
  {
    id: 'actor',
    light: 'marketing/captures/2026-11-05-final-walkthrough/08-actor-profile.png',
    alt: 'An actor profile shows event counts, an activity chart and recent events.',
    width: 1440,
    height: 900,
  },
  {
    id: 'first-event',
    light: 'marketing/captures/2026-11-05-final-walkthrough/23-first-event-received.png',
    alt: 'The integration checklist confirms that the first event has been received.',
    width: 1440,
    height: 900,
  },
];
export const clips: VideoEntry[] = [
  {
    id: 'onboarding',
    src: 'marketing/captures/2026-11-05-final-walkthrough/onboarding.webm',
    poster: 'marketing/captures/2026-11-05-final-walkthrough/22-first-event-listening.png',
    alt: 'The integration checklist demonstrates sending a first audit event.',
  },
  {
    id: 'query-investigation',
    src: 'marketing/captures/2026-11-05-final-walkthrough/query-investigation.webm',
    poster: 'marketing/captures/2026-11-05-final-walkthrough/qb-inv-02-query-results.png',
    alt: 'The explorer demonstrates building a query and investigating matching events.',
  },
];
export const imageWidths = (width: number) => [...new Set([640, 1024, 1600].map((size) => Math.min(size, width)))];
