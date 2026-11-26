import { expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';

type Call = { url: string; query: Record<string, unknown>; signal: AbortSignal };
const calls: Call[] = [];
let respond: (call: Call) => Promise<unknown> = async () => ({ data: [], nextCursor: null, total: 0, tookMs: 0 });
vi.mock('#imports', () => ({
  useRequestFetch: () => (url: string, options: { query: Record<string, unknown>; signal: AbortSignal }) => {
    const call = { url, query: options.query, signal: options.signal };
    calls.push(call);
    return respond(call);
  },
}));
const { useAuditTrail } = await import('./composable');

const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await nextTick();
    await Promise.resolve();
  }
};
function run<T>(make: () => T) {
  const scope = effectScope();
  const trail = scope.run(make) as T;
  return { trail, stop: () => scope.stop() };
}
const page = (ids: string[], nextCursor: string | null = null) => ({ data: ids.map((id) => ({ id })), nextCursor, total: ids.length, tookMs: 0 });

it('sends the documented empty trail to its own route, and throws on a selector without a value', async () => {
  calls.length = 0;
  const empty = run(() => useAuditTrail({ range: 'server-default' }));
  const missing = run(() => useAuditTrail({ tenant: undefined, range: 'server-default' }));
  await settle();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe('/api/_logbird/events');
  expect(calls[0]?.query).toEqual({});
  expect(missing.trail.error.value?.message).toMatch(/`tenant` was given but is empty/);
  empty.stop();
  missing.stop();
});

it('needs a trail with a selector to name its window; the empty trail leaves it to the route, with the order', async () => {
  calls.length = 0;
  const none = run(() => useAuditTrail({ tenant: 'acme' }));
  const toOnly = run(() => useAuditTrail({ tenant: 'acme', range: { to: '2026-11-02T00:00:00.000Z' } }));
  const asc = run(() => useAuditTrail({ range: { from: '2026-11-01T00:00:00.000Z' }, order: 'asc' }));
  await settle();
  expect(none.trail.error.value?.message).toMatch(/a trail needs a `range`/);
  expect(toOnly.trail.error.value?.message).toMatch(/`range` has no `from`/);
  expect(calls.map((c) => c.query)).toEqual([{ from: '2026-11-01T00:00:00.000Z', order: 'asc' }]);
  none.stop();
  toOnly.stop();
  asc.stop();
});

it('passes the boundary: Date bounds become ISO strings and a wrong-typed value is refused before any request', async () => {
  calls.length = 0;
  const from = new Date('2026-11-01T00:00:00.000Z');
  const ok = run(() => useAuditTrail({ range: { from } }));
  const bad = run(() => useAuditTrail({ range: { from: { toJSON: () => 'x' } as unknown as Date } }));
  await settle();
  expect(calls.map((c) => c.query)).toEqual([{ from: '2026-11-01T00:00:00.000Z' }]);
  expect(bad.trail.error.value?.name).toBe('TrailQueryError');
  ok.stop();
  bad.stop();
});

it('drops rows, cursor and the read in flight when the session changes', async () => {
  calls.length = 0;
  respond = async (call) => {
    if (call.query.cursor) return new Promise(() => undefined);
    return calls.length === 1 ? page(['a-1'], 'a-next') : page(['b-1']);
  };
  const session = ref('user-a');
  const { trail, stop } = run(() => useAuditTrail(() => ({ session: session.value, range: 'server-default' as const })));
  await settle();
  expect(trail.data.value.map((e) => e.id)).toEqual(['a-1']);
  void trail.loadMore();
  expect(calls[1]?.query.cursor).toBe('a-next');
  session.value = 'user-b';
  await settle();
  expect(calls[1]?.signal.aborted).toBe(true);
  expect(calls[2]?.query.cursor).toBeUndefined();
  expect(trail.data.value.map((e) => e.id)).toEqual(['b-1']);
  expect(trail.nextCursor.value).toBeNull();
  stop();
});
