// @vitest-environment happy-dom
import type { WebhookEndpoint } from '@logbird/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const again = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Send again'));
  if (!again) throw new Error('Send again missing');
  return again;
}

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  resend.mockClear();
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
  await act(async () => {
    again.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(resend).toHaveBeenCalledWith('qa-project', 'qa-endpoint-1', 'qa-delivery-1');
});

it('a hold newer than the page refreshes the endpoint and says so without guessing which hold', async () => {
  const { ApiRequestError } = await import('@/lib/api/errors');
  const { toast } = await import('sonner');
  const error = vi.spyOn(toast, 'error').mockImplementation(() => 'held');
  resend.mockRejectedValueOnce(new ApiRequestError(409, 'webhook_filter_review_required', 'held'));
  const again = await open(null);
  const invalidate = vi.spyOn(lastClient as QueryClient, 'invalidateQueries');
  await act(async () => {
    again.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(error).toHaveBeenCalledWith('Could not send it again', {
    description: 'This endpoint was just paused because of its filter. Its card now says what to do.',
  });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects', 'qa-project', 'webhooks'] });
  error.mockRestore();
});

it('shows every status again after a resend, so a Failed filter never hides the pending resend', async () => {
  const again = await open(null);
  const failedFilter = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Failed');
  if (!failedFilter) throw new Error('Failed filter missing');
  await act(async () => {
    failedFilter.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(failedFilter.getAttribute('aria-pressed')).toBe('true');
  const sendAgain = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Send again')) ?? again;
  await act(async () => {
    sendAgain.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(resend).toHaveBeenCalled();
  const all = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'All');
  expect(all?.getAttribute('aria-pressed')).toBe('true');
});

it('keeps following a resend until it is no longer pending, even when no loaded row shows it pending', async () => {
  const again = await open(null);
  pendingIds.current = ['qa-delivery-1'];
  const allReads = () => deliveries.mock.calls.filter(([, , q]) => !(q as { status?: string }).status).length;
  await act(async () => {
    again.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  // The resend is still pending: the watcher reads the pending list.
  expect(deliveries.mock.calls.some(([, , q]) => (q as { status?: string }).status === 'pending')).toBe(true);
  const before = allReads();
  // It settles (no longer pending): within the next poll the log reloads to show how it ended.
  pendingIds.current = [];
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 3400));
  });
  expect(allReads()).toBeGreaterThan(before);
}, 10_000);

it('settles a resend from a pending list longer than one page, reading every page', async () => {
  const others = Array.from({ length: 45 }, (_, i) => `qa-other-${i}`);
  const again = await open(null);
  // The resend sits on the third page of pending deliveries.
  pendingIds.current = [...others, 'qa-delivery-1'];
  const allReads = () => deliveries.mock.calls.filter(([, , q]) => !(q as { status?: string }).status).length;
  await act(async () => {
    again.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  expect(deliveries.mock.calls.some(([, , q]) => (q as { cursor?: string }).cursor === '40')).toBe(true);
  const before = allReads();
  // It settles while 45 others are still pending: three pages to read, and the log reloads.
  pendingIds.current = others;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 3400));
  });
  expect(allReads()).toBeGreaterThan(before);
}, 10_000);

it('says how many events in the project came too late for the window', async () => {
  await open(null);
  expect(document.querySelector('[data-testid="late-events"]')?.textContent).toMatch(
    /^Since .+, Logbird has recorded no event in this project arriving more than 7 days after it happened\.$/,
  );
});

it('shows the late count only from a read made since the log opened, and says when that read failed', async () => {
  // The list's copy has a 7-day window, but the fresh read fails: its sentence must not stand in as current.
  get.mockRejectedValueOnce(new Error('offline'));
  await open(null);
  expect(document.querySelector('[data-testid="late-events"]')).toBeNull();
  const failed = document.querySelector('[data-testid="late-events-error"]');
  expect(failed?.textContent).toContain('Could not load how many events came too late');
  const retry = [...(failed?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Try again');
  await act(async () => {
    retry?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(document.querySelector('[data-testid="late-events-error"]')).toBeNull();
  expect(document.querySelector('[data-testid="late-events"]')?.textContent).toMatch(/^Since .+, Logbird has recorded no event in this project/);
});

it('keeps "starts counting" tied to its read, and reads again once counting has started with the log open', async () => {
  // Counting starts 300 ms after the first read; the read after that has one event recorded.
  const startsAt = new Date(Date.now() + 300).toISOString();
  get.mockImplementationOnce(async () => ({ ...endpoint, lateEvents: { count: 0, since: startsAt } }));
  get.mockImplementationOnce(async () => ({ ...endpoint, lateEvents: { count: 1, since: startsAt } }));
  await open(null);
  const sentence = () => document.querySelector('[data-testid="late-events"]')?.textContent;
  expect(sentence()).toMatch(/^Logbird starts counting events that arrive more than 7 days late at /);
  const reads = get.mock.calls.length;
  // Past the start but before the re-read: a re-render (a filter click) must not turn the old read into "no event".
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  const failed = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Failed');
  await act(async () => {
    failed?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(sentence()).toMatch(/^Logbird starts counting/);
  // After the margin the endpoint is read again, and the count shows.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });
  expect(get.mock.calls.length).toBe(reads + 1);
  expect(sentence()).toMatch(/^Since .+, Logbird has recorded 1 event in this project arriving more than 7 days after it happened\./);
}, 10_000);

it('judges a read that crosses the start in flight by when it started, and reads again for the count', async () => {
  // The first read starts before counting does and answers after it; only the second read may supply a count.
  const startsAt = new Date(Date.now() + 200).toISOString();
  get.mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { ...endpoint, lateEvents: { count: 0, since: startsAt } };
  });
  get.mockImplementationOnce(async () => ({ ...endpoint, lateEvents: { count: 2, since: startsAt } }));
  await open(null);
  const sentence = () => document.querySelector('[data-testid="late-events"]')?.textContent;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
  expect(Date.now()).toBeGreaterThan(Date.parse(startsAt));
  expect(sentence()).toMatch(/^Logbird starts counting/);
  const reads = get.mock.calls.length;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });
  expect(get.mock.calls.length).toBe(reads + 1);
  expect(sentence()).toMatch(/^Since .+, Logbird has recorded 2 events in this project/);
}, 10_000);
