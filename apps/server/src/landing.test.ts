import { expect, it } from 'vitest';
import { companyFromEmail, pickLandingProject } from './landing';
import { projectHasNoStoredRows } from './project-emptiness';

const project = (id: string, day: number) => ({ id, createdAt: new Date(Date.UTC(2026, 10, day)) });

it('lands on the busiest project, not on a test project that received one event a moment ago', () => {
  const projects = [project('search-security-b', 7), project('joodcms', 1), project('shell-qa-empty', 6)];
  const stats = {
    'search-security-b': { lastEventAt: '2026-11-08T09:59:59.000Z', eventsLast24h: 1 },
    joodcms: { lastEventAt: '2026-11-08T09:58:00.000Z', eventsLast24h: 4120 },
    'shell-qa-empty': { lastEventAt: null, eventsLast24h: 0 },
  };
  expect(pickLandingProject(projects, stats)).toBe('joodcms');
});

it('breaks ties by the most recent event, then by the oldest project', () => {
  expect(
    pickLandingProject([project('a', 1), project('b', 2)], {
      a: { lastEventAt: '2026-11-01T00:00:00.000Z', eventsLast24h: 0 },
      b: { lastEventAt: '2026-11-05T00:00:00.000Z', eventsLast24h: 0 },
    }),
  ).toBe('b');
  expect(pickLandingProject([project('newer', 3), project('older', 2)], {})).toBe('older');
  expect(pickLandingProject([], {})).toBeNull();
});

it('suggests a workspace name only from company domains', () => {
  expect(companyFromEmail('lina@acme.com')).toEqual({ domain: 'acme.com', name: 'Acme' });
  expect(companyFromEmail('LINA@Bayt-Al-Rimal.co.uk')).toEqual({ domain: 'bayt-al-rimal.co.uk', name: 'Bayt Al Rimal' });
  expect(companyFromEmail('someone@gmail.com')).toBeNull();
  expect(companyFromEmail('someone@proton.me')).toBeNull();
  expect(companyFromEmail('demo@logbird.local')).toBeNull();
  expect(companyFromEmail('no-at-sign')).toBeNull();
});

function reader(tables: string[], withRows: string[], fail = false) {
  const queries: string[] = [];
  return {
    queries,
    query: (async ({ query }: { query: string }) => {
      queries.push(query);
      if (fail) throw new Error('system tables unavailable');
      const rows = query.includes('system.tables')
        ? tables.map((name) => ({ name }))
        : withRows.some((t) => query.includes(`\`${t}\``))
          ? [{ present: 1 }]
          : [];
      return { json: async () => rows };
    }) as never,
  };
}

it('treats a project as empty only when no project-scoped table has a row for it', async () => {
  const empty = reader(['events', 'events_by_minute', 'entities'], []);
  expect(await projectHasNoStoredRows(empty, 'p1')).toBe(true);
  expect(empty.queries.filter((q) => q.includes('LIMIT 1'))).toHaveLength(3);
  expect(await projectHasNoStoredRows(reader(['events', 'entities'], ['entities']), 'p1')).toBe(false);
  // Unknown state always keeps the full purge.
  expect(await projectHasNoStoredRows(reader([], []), 'p1')).toBe(false);
  expect(await projectHasNoStoredRows(reader(['events'], [], true), 'p1')).toBe(false);
});
