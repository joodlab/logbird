/**
 * Which project `/` opens once onboarding is done: the most active one. "Most active" is the most events in the last
 * 24 hours, then the most recent event, then the oldest project — so a busy production project wins over a test
 * project that received a single fixture event a moment ago, and a workspace with no traffic opens its first project.
 */
export function pickLandingProject(
  projects: readonly { id: string; createdAt: Date }[],
  stats: Readonly<Record<string, { lastEventAt: string | null; eventsLast24h: number } | undefined>>,
): string | null {
  const ranked = [...projects].sort((a, b) => {
    const sa = stats[a.id];
    const sb = stats[b.id];
    const volume = (sb?.eventsLast24h ?? 0) - (sa?.eventsLast24h ?? 0);
    if (volume) return volume;
    const recent = (sb?.lastEventAt ?? '').localeCompare(sa?.lastEventAt ?? '');
    if (recent) return recent;
    return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
  });
  return ranked[0]?.id ?? null;
}

/** Mailbox providers whose domain says nothing about the company (matched on the registrable label). */
const PERSONAL_DOMAINS = new Set([
  'gmail',
  'googlemail',
  'outlook',
  'hotmail',
  'live',
  'msn',
  'yahoo',
  'ymail',
  'icloud',
  'me',
  'mac',
  'aol',
  'proton',
  'protonmail',
  'pm',
  'gmx',
  'web',
  't-online',
  'freenet',
  'orange',
  'free',
  'laposte',
  'libero',
  'mail',
  'yandex',
  'rambler',
  'qq',
  '163',
  '126',
  'sina',
  'naver',
  'daum',
  'zoho',
  'fastmail',
  'hey',
  'tutanota',
  'tuta',
  'logbird',
]);

/**
 * Second-level labels under which companies register (`acme.co.uk`, `acme.com.au`). A small heuristic, not the full
 * Public Suffix List: it only decides which label names the company.
 */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'gouv', 'ltd', 'plc']);

/** `eu.mail.acme.co.uk` → `acme.co.uk`; null when there is no company label left. */
export function registrableDomain(host: string): string | null {
  const labels = host.trim().toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const twoPart = labels.length >= 3 && (labels.at(-1)?.length ?? 0) === 2 && SECOND_LEVEL.has(labels.at(-2) ?? '');
  return labels.slice(twoPart ? -3 : -2).join('.');
}

/**
 * "lina@eu.acme.co.uk" → { domain: "acme.co.uk", name: "Acme" }: the company is the registrable domain, not the first
 * label (`eu.`, `corp.`). Null for personal mailboxes and malformed addresses.
 */
export function companyFromEmail(email: string): { domain: string; name: string } | null {
  const host = email.split('@')[1];
  const domain = host ? registrableDomain(host) : null;
  const label = domain?.split('.')[0];
  if (!domain || !label || PERSONAL_DOMAINS.has(label)) return null;
  const name = label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return name.length >= 2 ? { domain, name } : null;
}
