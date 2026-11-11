import { afterEach, expect, it, vi } from 'vitest';
import { LegacySdk011Fixture } from './legacy-sdk-011-fixture';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('preserves the v0.1.1 identical retry loop, ignoring 503 details until terminal 202 onDrop', async () => {
  vi.useFakeTimers();
  const dropped = vi.fn();
  const rejected = [{ index: 0, code: 'invalid_event', reason: 'invalid_event: proven bad' }];
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'ingest_pending', details: { rejected } } }), { status: 503, headers: { 'Retry-After': '0' } }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          rejected: [...rejected, { index: 1, code: 'unverified_after_parse_failure', reason: 'unverified_after_parse_failure: unchecked' }],
        }),
        { status: 202 },
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  const legacy = new LegacySdk011Fixture({ apiKey: 'fictional', endpoint: 'http://unit.invalid', onDrop: dropped });
  legacy.track({ id: 'bad', action: 'qa91.legacy' });
  legacy.track({ id: 'unchecked', action: 'qa91.legacy' });
  legacy.track({ id: 'confirmed', action: 'qa91.legacy' });
  const flushing = legacy.flush();
  expect(dropped).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  await flushing;
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);
  expect(new Headers(fetcher.mock.calls[0]![1].headers).get('Logbird-Retry')).toBeNull();
  expect(dropped.mock.calls.map(([event]) => event.id)).toEqual(['bad', 'unchecked']);
  expect(legacy.queueSize).toBe(0);
});
