import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-client', () => ({ authClient: {} }));

const { ApiRequestError, timeoutError, toApiError, withDeadline } = await import('./errors');
const { BUSY_RETRIES, retryDelay, shouldRetry } = await import('./queries');

const busy = (retryAfter: number | null = 1) => new ApiRequestError(503, 'project_busy', 'busy', undefined, retryAfter);

describe('shouldRetry', () => {
  it('retries a busy project patiently and gives up eventually', () => {
    expect(shouldRetry(1, busy())).toBe(true);
    expect(shouldRetry(BUSY_RETRIES - 1, busy())).toBe(true);
    expect(shouldRetry(BUSY_RETRIES, busy())).toBe(false);
  });

  it('never retries 4xx or a request that already hit its deadline', () => {
    expect(shouldRetry(0, new ApiRequestError(403, 'forbidden', 'no'))).toBe(false);
    expect(shouldRetry(0, timeoutError())).toBe(false);
    expect(shouldRetry(0, new TypeError('fetch failed'))).toBe(true);
    expect(shouldRetry(2, new TypeError('fetch failed'))).toBe(false);
  });
});

describe('retryDelay', () => {
  it('backs off and never retries sooner than Retry-After', () => {
    expect(retryDelay(0, busy(1))).toBe(1000);
    expect(retryDelay(3, busy(1))).toBe(8000);
    expect(retryDelay(6, busy(1))).toBe(10_000);
    expect(retryDelay(0, busy(5))).toBe(5000);
    expect(retryDelay(0, busy(120))).toBe(30_000);
  });
});

describe('toApiError', () => {
  it('keeps Retry-After and explains a busy project', async () => {
    const response = new Response(JSON.stringify({ error: { code: 'project_busy', message: 'Project is busy.' } }), {
      status: 503,
      headers: { 'retry-after': '2', 'content-type': 'application/json' },
    });
    const error = await toApiError(response);
    expect(error.code).toBe('project_busy');
    expect(error.retryAfter).toBe(2);
    expect(error.message).toMatch(/retention purge/);
  });

  it('turns a role 403 into a plain explanation', async () => {
    const response = new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Workspace owner or admin access required.' } }), {
      status: 403,
    });
    expect((await toApiError(response)).message).toBe('Only workspace owners and admins can do this.');
  });
});

describe('withDeadline', () => {
  it('rejects with a timeout error when the promise never settles', async () => {
    vi.useFakeTimers();
    const pending = withDeadline(new Promise(() => undefined), 15_000);
    vi.advanceTimersByTime(15_000);
    await expect(pending).rejects.toMatchObject({ code: 'timeout', status: 504 });
    vi.useRealTimers();
  });
});
