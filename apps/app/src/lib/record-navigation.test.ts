// Record A → record B (#220 item 4): while B loads, nothing of A may be read as B's. The record page and its embedded
// history read every placeholder-carrying query through `current()` (enforced for all of them by current.test.tsx); this
// pins the behaviour for the exact queries a record-to-record navigation switches.
import { formatRecordTerm } from '@logbird/contracts';
import { InfiniteQueryObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

// B's answers never arrive in this test: only A's cached answers exist.
const { never } = vi.hoisted(() => ({ never: () => new Promise<never>(() => undefined) }));
vi.mock('@/lib/api/client', () => ({
  api: { events: { search: vi.fn(never), histogram: vi.fn(never) }, entities: { profile: vi.fn(never) } },
}));

import { current } from './api/current';
import { entityProfileQuery, eventsInfiniteQuery, histogramQuery } from './api/queries';
import { scopedQuery } from './query-language';

const project = 'qa-project';
const range = '30d';
const historyOf = (type: string, id: string) => scopedQuery(formatRecordTerm(type, id), '').q ?? '';
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(() => client.clear());

it("never reads record A's history, chart or profile as record B's while B loads", async () => {
  const a = { type: 'page', id: 'qa-a' };
  const b = { type: 'page', id: 'qa-b' };
  const aHistory = historyOf(a.type, a.id);
  const bHistory = historyOf(b.type, b.id);
  client.setQueryData(eventsInfiniteQuery(project, range, aHistory).queryKey, {
    pages: [{ data: [{ id: 'qa-event-of-a' }] }],
    pageParams: [null],
  } as never);
  client.setQueryData(histogramQuery(project, range, aHistory).queryKey, { buckets: [{ total: 9 }] } as never);
  client.setQueryData(entityProfileQuery(project, 'target', `${a.type}:${a.id}`, range, a.type).queryKey, { entity: { name: 'A' } } as never);

  // Observers move from A's keys to B's, as the page does when the route's record changes.
  const rows = new InfiniteQueryObserver(client, eventsInfiniteQuery(project, range, aHistory) as never);
  const chart = new QueryObserver(client, histogramQuery(project, range, aHistory) as never);
  const profile = new QueryObserver(client, entityProfileQuery(project, 'target', `${a.type}:${a.id}`, range, a.type) as never);
  const stop = [rows.subscribe(() => undefined), chart.subscribe(() => undefined), profile.subscribe(() => undefined)];
  expect(current(rows.getCurrentResult())).toBeDefined();

  rows.setOptions(eventsInfiniteQuery(project, range, bHistory) as never);
  chart.setOptions(histogramQuery(project, range, bHistory) as never);
  profile.setOptions(entityProfileQuery(project, 'target', `${b.type}:${b.id}`, range, b.type) as never);

  // The rows and chart may hold A's answer as a placeholder, but `current()` never hands it out as B's.
  for (const observer of [rows, chart]) {
    const result = observer.getCurrentResult();
    expect(result.data === undefined || result.isPlaceholderData).toBe(true);
    expect(current(result)).toBeUndefined();
  }
  // The profile keeps no placeholder across records at all.
  expect(profile.getCurrentResult().data).toBeUndefined();
  for (const unsubscribe of stop) unsubscribe();
});
