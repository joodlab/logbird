// @vitest-environment happy-dom
import type { WebhookEndpoint } from '@logbird/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const { resend, failedPing, deliveries, pendingIds } = vi.hoisted(() => ({
  // What the pending list holds (the resend watcher reads it); everything else answers with the one failed ping.
  pendingIds: { current: [] as string[] },
  deliveries: vi.fn(async (_p: string, _e: string, query: { status?: string }) => ({ data: [], nextCursor: null }) as unknown),
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
  api: { webhooks: { deliveries, resend } },
}));

import { DeliveryLog } from './delivery-log';

deliveries.mockImplementation(async (_p: string, _e: string, query: { status?: string }) =>
  query.status === 'pending'
    ? { data: pendingIds.current.map((id) => ({ ...failedPing, id, status: 'pending' })), nextCursor: null }
    : { data: [failedPing], nextCursor: null },
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let lastClient: QueryClient | undefined;
const endpoint = { id: 'qa-endpoint-1', url: 'https://example.com/qa-hook' } as WebhookEndpoint;

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
