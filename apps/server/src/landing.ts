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

/** Mailbox providers whose domain says nothing about the company. */
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
  'mail',
  'yandex',
  'zoho',
  'fastmail',
  'hey',
  'tutanota',
  'logbird',
]);

/** "lina@acme.co.uk" → { domain: "acme.co.uk", name: "Acme" }; null for personal mailboxes and malformed addresses. */
export function companyFromEmail(email: string): { domain: string; name: string } | null {
  const domain = email.split('@')[1]?.trim().toLowerCase();
  const label = domain?.split('.')[0];
  if (!domain || !label || PERSONAL_DOMAINS.has(label)) return null;
  const name = label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return name.length >= 2 ? { domain, name } : null;
}
