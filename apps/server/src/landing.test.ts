import { expect, it } from 'vitest';
import { companyFromEmail, pickLandingProject } from './landing';

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
  // The company is the registrable domain, not the first label.
  expect(companyFromEmail('lina@eu.acme.com')).toEqual({ domain: 'acme.com', name: 'Acme' });
  expect(companyFromEmail('lina@corp.mail.acme.co.uk')).toEqual({ domain: 'acme.co.uk', name: 'Acme' });
  expect(companyFromEmail('lina@acme.com.au.')).toEqual({ domain: 'acme.com.au', name: 'Acme' });
  expect(companyFromEmail('owner@qa-fix-backlogs-1a2b3c4d.test')).toEqual({
    domain: 'qa-fix-backlogs-1a2b3c4d.test',
    name: 'Qa Fix Backlogs 1a2b3c4d',
  });
  for (const personal of ['a@web.de', 'a@qq.com', 'a@163.com', 'a@naver.com', 'a@t-online.de', 'a@orange.fr', 'a@free.fr', 'a@mail.yahoo.co.jp'])
    expect(companyFromEmail(personal)).toBeNull();
  expect(companyFromEmail('someone@gmail.com')).toBeNull();
  expect(companyFromEmail('someone@proton.me')).toBeNull();
  expect(companyFromEmail('demo@logbird.local')).toBeNull();
  expect(companyFromEmail('no-at-sign')).toBeNull();
});
