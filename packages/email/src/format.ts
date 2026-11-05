/** Formatting shared by the HTML and plain-text parts so both always say exactly the same thing. */

const dateTime = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});
const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });

/** "Nov 5, 2026, 14:32 UTC" — recipients' time zones are unknown, so be explicit. */
export const formatDateTime = (date: Date) => `${dateTime.format(date)} UTC`;
/** "14:32 UTC" */
export const formatTime = (date: Date) => `${time.format(date)} UTC`;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** Coarse, honest relative duration: "in 10 minutes", "in 2 days". */
export function formatRelative(target: Date, now: Date) {
  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${plural(minutes, 'minute')}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${plural(hours, 'hour')}`;
  return `in ${plural(Math.round(hours / 24), 'day')}`;
}

export const roleLabel = (role: string) => (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Member');

/** One line per role: what someone with it can actually do in Trailmark. */
export const ROLE_SUMMARY: Record<string, string> = {
  owner: 'Full control of the workspace, including deleting it and managing other owners.',
  admin: 'Manages projects, API keys, retention and members.',
  member: 'Explores events, follows actors and records, and saves views.',
};
export const roleSummary = (role: string) => ROLE_SUMMARY[role] ?? ROLE_SUMMARY.member;

export const withArticle = (word: string) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;

/** Several better-auth roles can be stored comma-separated; show the first as the primary role. */
export const primaryRole = (role: string | null | undefined) => (role ?? 'member').split(',')[0]?.trim() || 'member';

const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Version\/[\d.]+.*Safari\//, 'Safari'],
  [/^curl\//, 'curl'],
];
const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

/** "Chrome on Windows" from a User-Agent header; undefined when it says nothing useful. */
export function describeUserAgent(userAgent: string | undefined) {
  if (!userAgent) return;
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system;
}

/** First hop of X-Forwarded-For, or the value itself. */
export const clientIp = (forwardedFor: string | null | undefined) => forwardedFor?.split(',')[0]?.trim() || undefined;

export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
