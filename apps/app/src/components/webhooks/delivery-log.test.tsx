// @vitest-environment happy-dom
import type { WebhookEndpoint } from '@logbird/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { resend, failedPing, deliveries, pendingIds, get } = vi.hoisted(() => ({
  // The endpoint read fresh when the log opens.
  get: vi.fn(async (): Promise<unknown> => null),
  // What the pending list holds (the resend watcher reads it); everything else answers with the one failed ping.
  pendingIds: { current: [] as string[] },
  deliveries: vi.fn(async (_p: string, _e: string, _query: { status?: string }) => ({ data: [], nextCursor: null }) as unknown),
  resend: vi.fn(async (_projectId: string, _endpointId: string, _deliveryId: string) => ({})),
  // A finished test ping: the only kind of row that offers "Send again" without a router link.
  failedPing: {
    id: 'qa-delivery-1',
    kind: 'test',
    status: 'failed',
    eventId: null,
    createdAt: '2026-11-23T00:00:00.000Z',
    attemptCount: 1,
    nextAttemptAt: null,
    attempts: [
      { number: 1, status: 'failed', startedAt: '2026-11-23T00:00:00.000Z', responseCode: 405, latencyMs: 200, error: null, responseBody: null },
    ],
  },
}));
vi.mock('@/lib/api/client', () => ({
  api: { webhooks: { deliveries, resend, get } },
}));

import { DeliveryLog } from './delivery-log';

// The pending list answers in pages of 20, like the API: a cursor is the index of the next page's first row.
deliveries.mockImplementation(async (_p: string, _e: string, query: { status?: string; cursor?: string }) => {
  if (query.status !== 'pending') return { data: [failedPing], nextCursor: null };
  const from = Number(query.cursor ?? 0);
  const page = pendingIds.current.slice(from, from + 20);
  return {
    data: page.map((id) => ({ ...failedPing, id, status: 'pending' })),
    nextCursor: from + 20 < pendingIds.current.length ? String(from + 20) : null,
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let lastClient: QueryClient | undefined;
const endpoint = {
  id: 'qa-endpoint-1',
  url: 'https://example.com/qa-hook',
  deliveryWindowSeconds: 604_800,
  lateEvents: { count: 0, since: '2026-10-25T00:00:00.000Z' },
} as WebhookEndpoint;
get.mockImplementation(async () => endpoint);

// Fake timers and clock: every wait below advances time on purpose, so a slow runner can never lose a race.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-11-24T10:00:00.000Z'));
});
/** Advances the fake clock by `ms`, running due timers and the promises they settle. */
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
/** Advances the fake clock in small steps until `check` holds; fails after `limitMs` of fake time. */
async function until(check: () => boolean, what: string, limitMs = 1000) {
  for (let waited = 0; !check(); waited += 10) {
    if (waited >= limitMs) throw new Error(`${what}: not within ${limitMs} ms`);
    await advance(10);
  }
}
const button = (label: string, exact = false) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => (exact ? b.textContent?.trim() === label : b.textContent?.includes(label)));
const sentence = () => document.querySelector('[data-testid="late-events"]')?.textContent ?? '';
const pendingRead = () => deliveries.mock.calls.some(([, , q]) => (q as { status?: string }).status === 'pending');

async function open(sendBlocked: string | null) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastClient = client;
  act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <DeliveryLog endpoint={endpoint} onOpenChange={vi.fn()} open projectId="qa-project" sendBlocked={sendBlocked} />
      </QueryClientProvider>,
    ),
  );
  await until(() => Boolean(button('Send again')), 'Send again');
  return button('Send again') as HTMLButtonElement;
}

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  resend.mockClear();
  vi.useRealTimers();
});

it('says once why "Send again" is unavailable while the endpoint is off or held, and never asks the server', async () => {
  const again = await open('This endpoint is off: turn it on to send a delivery again.');
  expect(document.querySelector('[data-testid="send-blocked"]')?.textContent).toBe('This endpoint is off: turn it on to send a delivery again.');
  expect(again.disabled).toBe(true);
  act(() => again.click());
  expect(resend).not.toHaveBeenCalled();
});

it('offers "Send again" when nothing holds the endpoint', async () => {
  const again = await open(null);
  expect(document.querySelector('[data-testid="send-blocked"]')).toBeNull();
  expect(again.disabled).toBe(false);
  act(() => again.click());
  await until(() => resend.mock.calls.length > 0, 'resend');
  expect(resend).toHaveBeenCalledWith('qa-project', 'qa-endpoint-1', 'qa-delivery-1');
});

it('a hold newer than the page refreshes the endpoint and says so without guessing which hold', async () => {
  const { ApiRequestError } = await import('@/lib/api/errors');
  const { toast } = await import('sonner');
  const error = vi.spyOn(toast, 'error').mockImplementation(() => 'held');
  resend.mockRejectedValueOnce(new ApiRequestError(409, 'webhook_filter_review_required', 'held'));
  const again = await open(null);
  const invalidate = vi.spyOn(lastClient as QueryClient, 'invalidateQueries');
  act(() => again.click());
  await until(() => error.mock.calls.length > 0 && invalidate.mock.calls.length > 0, 'hold toast and refresh');
  expect(error).toHaveBeenCalledWith('Could not send it again', {
    description: 'This endpoint was just paused because of its filter. Its card now says what to do.',
  });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects', 'qa-project', 'webhooks'] });
  error.mockRestore();
});

it('shows every status again after a resend, so a Failed filter never hides the pending resend', async () => {
  const again = await open(null);
  act(() => button('Failed', true)?.click());
  await until(() => button('Failed', true)?.getAttribute('aria-pressed') === 'true' && Boolean(button('Send again')), 'Failed filter');
  act(() => (button('Send again') ?? again).click());
  await until(() => resend.mock.calls.length > 0 && button('All', true)?.getAttribute('aria-pressed') === 'true', 'All after resend');
  expect(resend).toHaveBeenCalled();
});

it('keeps following a resend until it is no longer pending, even when no loaded row shows it pending', async () => {
  const again = await open(null);
  pendingIds.current = ['qa-delivery-1'];
  const allReads = () => deliveries.mock.calls.filter(([, , q]) => !(q as { status?: string }).status).length;
  act(() => again.click());
  await until(() => resend.mock.calls.length > 0 && pendingRead(), 'pending read');
  // The resend is still pending: the watcher reads the pending list.
  expect(pendingRead()).toBe(true);
  const before = allReads();
  // It settles (no longer pending): within the next poll the log reloads to show how it ended.
  pendingIds.current = [];
  // Within one poll (3 s) the log reloads.
  await until(() => allReads() > before, 'reload after settling', 3400);
});

it('settles a resend from a pending list longer than one page, reading every page', async () => {
  const others = Array.from({ length: 45 }, (_, i) => `qa-other-${i}`);
  const again = await open(null);
  // The resend sits on the third page of pending deliveries.
  pendingIds.current = [...others, 'qa-delivery-1'];
  const allReads = () => deliveries.mock.calls.filter(([, , q]) => !(q as { status?: string }).status).length;
  act(() => again.click());
  await until(() => resend.mock.calls.length > 0 && pendingRead(), 'pending read');
  await until(() => deliveries.mock.calls.some(([, , q]) => (q as { cursor?: string }).cursor === '40'), 'third pending page');
  const before = allReads();
  // It settles while 45 others are still pending: three pages to read, and the log reloads.
  pendingIds.current = others;
  // Within one poll (3 s) the log reloads.
  await until(() => allReads() > before, 'reload after settling', 3400);
});

it('says how many events in the project came too late for the window', async () => {
  await open(null);
  await until(() => sentence() !== '', 'late sentence');
  expect(sentence()).toMatch(/^Since .+, Logbird has recorded no event in this project arriving more than 7 days after it happened\.$/);
});

it('shows the late count only from a read made since the log opened, and says when that read failed', async () => {
  // The list's copy has a 7-day window, but the fresh read fails: its sentence must not stand in as current.
  get.mockRejectedValueOnce(new Error('offline'));
  await open(null);
  await until(() => Boolean(document.querySelector('[data-testid="late-events-error"]')), 'late count error');
  expect(document.querySelector('[data-testid="late-events"]')).toBeNull();
  const failed = document.querySelector('[data-testid="late-events-error"]');
  expect(failed?.textContent).toContain('Could not load how many events came too late');
  const retry = [...(failed?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Try again');
  act(() => retry?.click());
  await until(() => sentence() !== '', 'late sentence after retry');
  expect(document.querySelector('[data-testid="late-events-error"]')).toBeNull();
  expect(sentence()).toMatch(/^Since .+, Logbird has recorded no event in this project/);
});

it('keeps "starts counting" tied to its read, and reads again once counting has started with the log open', async () => {
  // Counting starts 300 ms after the first read; the read after that has one event recorded.
  const startsAt = new Date(Date.now() + 300).toISOString();
  get.mockImplementationOnce(async () => ({ ...endpoint, lateEvents: { count: 0, since: startsAt } }));
  get.mockImplementationOnce(async () => ({ ...endpoint, lateEvents: { count: 1, since: startsAt } }));
  await open(null);
  await until(() => sentence() !== '', 'late sentence');
  expect(sentence()).toMatch(/^Logbird starts counting events that arrive more than 7 days late at /);
  const reads = get.mock.calls.length;
  // Past the start but before the re-read: a re-render (a filter click) must not turn the old read into "no event".
  await advance(600);
  act(() => button('Failed', true)?.click());
  await advance(50);
  expect(Date.now()).toBeGreaterThan(Date.parse(startsAt));
  expect(sentence()).toMatch(/^Logbird starts counting/);
  // After the margin (2 s past the start) the endpoint is read again, and the count shows.
  await until(() => /recorded 1 event/.test(sentence()), 'count after the margin', 2500);
  expect(get.mock.calls.length).toBe(reads + 1);
  expect(sentence()).toMatch(/^Since .+, Logbird has recorded 1 event in this project arriving more than 7 days after it happened\./);
});

it('judges a read that crosses the start in flight by when it started, and reads again for the count', async () => {
  // The first read starts before counting does and answers after it; only the second read may supply a count.
  const startsAt = new Date(Date.now() + 200).toISOString();
  get.mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { ...endpoint, lateEvents: { count: 0, since: startsAt } };
  });
  get.mockImplementationOnce(async () => ({ ...endpoint, lateEvents: { count: 2, since: startsAt } }));
  await open(null);
  // The first read answers at 400 ms, after counting started at 200 ms.
  await until(() => sentence() !== '', 'late sentence');
  expect(Date.now()).toBeGreaterThan(Date.parse(startsAt));
  expect(sentence()).toMatch(/^Logbird starts counting/);
  const reads = get.mock.calls.length;
  await until(() => /recorded 2 events/.test(sentence()), 'count after the margin', 2500);
  expect(get.mock.calls.length).toBe(reads + 1);
  expect(sentence()).toMatch(/^Since .+, Logbird has recorded 2 events in this project/);
});

it('marks every count as approximate, zero included, but not the "starts counting" line', async () => {
  await open(null);
  await until(() => sentence() !== '', 'late sentence');
  expect(sentence()).toMatch(/^Since .+, Logbird has recorded no event/);
  expect(document.querySelector('[data-testid="late-events-approximate"]')?.textContent).toBe(
    'Approximate. It can be off after a storage failure or a restore.',
  );
  act(() => root?.unmount());
  document.body.innerHTML = '';
  get.mockImplementationOnce(async () => ({ ...endpoint, lateEvents: { count: 0, since: new Date(Date.now() + 3_600_000).toISOString() } }));
  await open(null);
  await until(() => sentence() !== '', 'late sentence');
  expect(sentence()).toMatch(/^Logbird starts counting/);
  expect(document.querySelector('[data-testid="late-events-approximate"]')).toBeNull();
});

it('reopened while the first read is still pending, the log makes its own read and shows that count', async () => {
  let release: (value: unknown) => void = () => undefined;
  const before = get.mock.calls.length;
  get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  get.mockImplementationOnce(async () => ({ ...endpoint, lateEvents: { count: 4, since: endpoint.lateEvents.since } }));
  await open(null);
  const client = lastClient as QueryClient;
  const render = (isOpen: boolean) =>
    act(() =>
      root?.render(
        <QueryClientProvider client={client}>
          <DeliveryLog endpoint={endpoint} onOpenChange={vi.fn()} open={isOpen} projectId="qa-project" sendBlocked={null} />
        </QueryClientProvider>,
      ),
    );
  // Close and reopen while the first read is still in flight.
  render(false);
  await advance(20);
  render(true);
  await until(() => get.mock.calls.length - before === 2, 'second read');
  // The first read lands late; it belongs to the earlier opening and must not decide this one.
  act(() => release({ ...endpoint, lateEvents: { count: 9, since: endpoint.lateEvents.since } }));
  await until(() => sentence() !== '', 'late sentence');
  await advance(50);
  expect(get.mock.calls.length - before).toBe(2);
  expect(sentence()).toMatch(/Logbird has recorded 4 events/);
});
