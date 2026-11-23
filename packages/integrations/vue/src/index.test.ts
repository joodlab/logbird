// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
import { h, reactive, ref } from 'vue';
import { type AuditFetcher, type AuditTrailOptions, useAuditTrail, useAuditTrailRequests } from './index';

it('refreshes selectors, paginates and exposes errors without exposing keys', async () => {
  const target = ref('one');
  const fetcher = vi.fn().mockResolvedValue({ data: [{ id: 'a' }], nextCursor: 'cursor' });
  let trail!: ReturnType<typeof useAuditTrail>;
  const wrapper = mount({
    setup() {
      trail = useAuditTrail(() => ({ fetcher, target: { id: target.value } }));
      return () => h('span', String(trail.data.value.length));
    },
  });
  await flushPromises();
  expect(wrapper.text()).toBe('1');
  await trail.loadMore();
  expect(fetcher.mock.calls[1]?.[0].cursor).toBe('cursor');
  expect(trail.data.value).toHaveLength(1);
  target.value = 'two';
  await flushPromises();
  expect(fetcher.mock.lastCall?.[0].q).toContain('two');
  fetcher.mockRejectedValueOnce(new Error('forbidden'));
  await trail.refresh();
  expect(trail.error.value?.message).toBe('forbidden');
  wrapper.unmount();
});

it('ignores a stale response after the record changes', async () => {
  const target = ref('old');
  let resolveOld!: (page: Awaited<ReturnType<import('./index').AuditFetcher>>) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue({ data: [{ id: 'new' }], nextCursor: null });
  let trail!: ReturnType<typeof useAuditTrail>;
  const wrapper = mount({
    setup() {
      trail = useAuditTrail(() => ({ fetcher, target: { id: target.value } }));
      return () => h('span', trail.data.value[0]?.id);
    },
  });
  target.value = 'new';
  await flushPromises();
  resolveOld({ data: [], nextCursor: null, total: 0, tookMs: 0 });
  await flushPromises();
  expect(wrapper.text()).toBe('new');
  wrapper.unmount();
});

it('exposes initial read failure and recovers on refresh', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ data: [{ id: 'recovered' }], nextCursor: null });
  let trail!: ReturnType<typeof useAuditTrail>;
  const wrapper = mount({
    setup() {
      trail = useAuditTrail({ fetcher, target: { id: 'inv_1' } });
      return () => h('span', trail.error.value?.message ?? (trail.loading.value ? 'loading' : 'ready'));
    },
  });
  await flushPromises();
  expect(wrapper.text()).toBe('offline');
  expect(trail.loading.value).toBe(false);
  await expect(trail.refresh()).resolves.toBeUndefined();
  expect(trail.error.value).toBeUndefined();
  expect(trail.data.value[0]?.id).toBe('recovered');
  wrapper.unmount();
});

it('never fetches a wider trail when a selector has no value; it reports the error and clears the old rows (#263)', async () => {
  const tenant = ref<string | undefined>('t1');
  const fetcher = vi.fn().mockResolvedValue({ data: [{ id: 'mine' }], nextCursor: null });
  let trail!: ReturnType<typeof useAuditTrail>;
  const wrapper = mount({
    setup() {
      trail = useAuditTrail(() => ({ fetcher, tenant: tenant.value }));
      return () => h('span', String(trail.data.value.length));
    },
  });
  await flushPromises();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.lastCall?.[0].q).toBe('tenant:"t1"');
  tenant.value = undefined;
  await flushPromises();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(trail.error.value).toBeInstanceOf(TypeError);
  expect(trail.error.value?.message).toMatch(/`tenant` was given but is empty/);
  expect(trail.data.value).toEqual([]);
  expect(trail.loading.value).toBe(false);
  await trail.refresh();
  await trail.loadMore();
  expect(fetcher).toHaveBeenCalledTimes(1);
  tenant.value = 't2';
  await flushPromises();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(trail.error.value).toBeUndefined();
  wrapper.unmount();
});

// Review round 1 on #311.
it('tracks a selector key added later to reactive options and refetches with it', async () => {
  const { reactive } = await import('vue');
  const fetcher = vi.fn().mockResolvedValue({ data: [{ id: 'a' }], nextCursor: null });
  const options = reactive<Record<string, unknown>>({ fetcher, target: { id: 'inv_1' } });
  let trail!: ReturnType<typeof useAuditTrail>;
  const wrapper = mount({
    setup() {
      trail = useAuditTrail(() => options as unknown as AuditTrailOptions);
      return () => h('span', String(trail.data.value.length));
    },
  });
  await flushPromises();
  expect(fetcher.mock.lastCall?.[0].q).toBe('target:"inv_1"');
  options.tenant = 'acme';
  await flushPromises();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.lastCall?.[0].q).toBe('target:"inv_1" AND tenant:"acme"');
  options.tenant = undefined;
  await flushPromises();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(trail.data.value).toEqual([]);
  expect(trail.error.value?.message).toMatch(/`tenant`/);
  wrapper.unmount();
});

it('clears rows and cursor when loadMore finds the trail invalid, and fetches nothing', async () => {
  const options: Record<string, unknown> = { tenant: 'acme' };
  const fetcher = vi.fn().mockResolvedValue({ data: [{ id: 'first' }], nextCursor: 'next' });
  options.fetcher = fetcher;
  let trail!: ReturnType<typeof useAuditTrail>;
  const wrapper = mount({
    setup() {
      // A plain (non-reactive) object: no watch update when it changes, so loadMore is the first to see it.
      trail = useAuditTrail(() => options as unknown as AuditTrailOptions);
      return () => h('span', String(trail.data.value.length));
    },
  });
  await flushPromises();
  expect(trail.nextCursor.value).toBe('next');
  expect(trail.data.value).toHaveLength(1);
  options.tenant = '';
  await trail.loadMore();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(trail.data.value).toEqual([]);
  expect(trail.nextCursor.value).toBeNull();
  expect(trail.loading.value).toBe(false);
  expect(trail.error.value).toBeInstanceOf(TypeError);
  wrapper.unmount();
});

it('treats throwing options as an error: refresh resolves, loading ends, rows go, nothing is fetched', async () => {
  let broken = false;
  let release!: (page: unknown) => void;
  const fetcher = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  let trail!: ReturnType<typeof useAuditTrail>;
  const wrapper = mount({
    setup() {
      trail = useAuditTrail(() => {
        if (broken) throw new Error('options unavailable');
        return { fetcher, tenant: 'acme' } as unknown as AuditTrailOptions;
      });
      return () => h('span', String(trail.data.value.length));
    },
  });
  await flushPromises();
  expect(trail.loading.value).toBe(true);
  broken = true;
  await expect(trail.refresh()).resolves.toBeUndefined();
  release({ data: [{ id: 'late' }], nextCursor: null });
  await flushPromises();
  expect(trail.loading.value).toBe(false);
  expect(trail.error.value?.message).toBe('options unavailable');
  expect(trail.data.value).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  wrapper.unmount();
});

it('keeps a non-enumerable selector instead of dropping it in a spread', async () => {
  const fetcher = vi.fn().mockResolvedValue({ data: [], nextCursor: null });
  const options = { fetcher, target: { id: 'inv_1' } };
  Object.defineProperty(options, 'tenant', { value: 'acme', enumerable: false });
  const wrapper = mount({
    setup() {
      useAuditTrail(() => options);
      return () => h('span');
    },
  });
  await flushPromises();
  expect(fetcher.mock.lastCall?.[0].q).toBe('target:"inv_1" AND tenant:"acme"');
  wrapper.unmount();
});

it('runs a caller-built request as given (the Nuxt adapter), with no cursor on page one', async () => {
  const fetcher = vi.fn().mockResolvedValue({ data: [], nextCursor: null });
  const wrapper = mount({
    setup() {
      useAuditTrailRequests(() => ({ query: { limit: 25, cursor: 'stale' }, fetcher }));
      return () => h('span');
    },
  });
  await flushPromises();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.lastCall?.[0]).toEqual({ limit: 25 });
  wrapper.unmount();
});

it('cannot be made to send an empty trail by a scopedByServer key spread into its options', async () => {
  const fetcher = vi.fn().mockResolvedValue({ data: [{ id: 'everyone' }], nextCursor: null });
  // Options assembled elsewhere and spread in, carrying the flag: the composable must ignore it.
  const inherited = { scopedByServer: true, limit: 25 };
  let trail!: ReturnType<typeof useAuditTrail>;
  const wrapper = mount({
    setup() {
      trail = useAuditTrail(() => ({ ...inherited, fetcher }) as unknown as AuditTrailOptions);
      return () => h('span', String(trail.data.value.length));
    },
  });
  await flushPromises();
  expect(fetcher).not.toHaveBeenCalled();
  expect(trail.error.value?.message).toMatch(/an empty trail would be the whole project/);
  expect(trail.data.value).toEqual([]);
  wrapper.unmount();
});

// Review round 2 on #311.
it('runs the snapshot its watcher validated: an invalid read is an error even if the next read would look valid', async () => {
  const fetcher = vi.fn().mockResolvedValue({ data: [{ id: 'everyone-of-the-target' }], nextCursor: null });
  let reads = 0;
  let trail!: ReturnType<typeof useAuditTrail>;
  const wrapper = mount({
    setup() {
      trail = useAuditTrail(() => {
        reads++;
        // First read: the tenant key is present without a value. Any later read: only the target.
        return (reads === 1 ? { fetcher, target: { id: 'inv_1' }, tenant: undefined } : { fetcher, target: { id: 'inv_1' } }) as AuditTrailOptions;
      });
      return () => h('span', String(trail.data.value.length));
    },
  });
  await flushPromises();
  expect(fetcher).not.toHaveBeenCalled();
  expect(trail.error.value?.message).toMatch(/`tenant`/);
  wrapper.unmount();
});

it('never continues the rows or cursor of one tenant for another: a changed trail on loadMore starts again at page one', async () => {
  const options: Record<string, unknown> = { tenant: 'acme' };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({ data: [{ id: 'acme-1' }], nextCursor: 'acme-cursor' })
    .mockResolvedValueOnce({ data: [{ id: 'globex-1' }], nextCursor: null })
    .mockRejectedValueOnce(new Error('forbidden'));
  options.fetcher = fetcher;
  let trail!: ReturnType<typeof useAuditTrail>;
  const wrapper = mount({
    setup() {
      trail = useAuditTrail(() => options as unknown as AuditTrailOptions);
      return () => h('span', String(trail.data.value.length));
    },
  });
  await flushPromises();
  expect(trail.data.value.map((e) => e.id)).toEqual(['acme-1']);
  options.tenant = 'globex';
  await trail.loadMore();
  expect(fetcher.mock.calls[1]?.[0]).toMatchObject({ q: 'tenant:"globex"' });
  expect(fetcher.mock.calls[1]?.[0].cursor).toBeUndefined();
  expect(trail.data.value.map((e) => e.id)).toEqual(['globex-1']);
  // A refused read leaves nothing of the trail on screen.
  await trail.refresh();
  expect(trail.error.value?.message).toBe('forbidden');
  expect(trail.data.value).toEqual([]);
  expect(trail.nextCursor.value).toBeNull();
  wrapper.unmount();
});

it('never sends a cursor from the options on page one, and survives a thrown object without a toString', async () => {
  const fetcher = vi.fn().mockResolvedValue({ data: [], nextCursor: null });
  let broken = false;
  let trail!: ReturnType<typeof useAuditTrail>;
  const wrapper = mount({
    setup() {
      trail = useAuditTrail(() => {
        if (broken) throw Object.create(null);
        return { fetcher, tenant: 'acme', cursor: 'stale' } as AuditTrailOptions;
      });
      return () => h('span');
    },
  });
  await flushPromises();
  expect(fetcher.mock.lastCall?.[0].cursor).toBeUndefined();
  broken = true;
  await expect(trail.refresh()).resolves.toBeUndefined();
  expect(trail.loading.value).toBe(false);
  expect(trail.error.value).toBeInstanceOf(Error);
  wrapper.unmount();
});

// Round 4 on #311: the composable runs on the SDK's input boundary (one frozen snapshot of primitives per read), and
// its rows and cursor belong to that snapshot's canonical key, the session and the fetcher.
const ISO = '2026-11-01T00:00:00.000Z';
const page = (ids: string[], nextCursor: string | null = null) =>
  ({ data: ids.map((id) => ({ id })), nextCursor, total: ids.length, tookMs: 0 }) as unknown as Awaited<ReturnType<AuditFetcher>>;
function mountTrail<T>(make: () => T) {
  let trail!: T;
  const wrapper = mount({
    setup() {
      trail = make();
      return () => h('span');
    },
  });
  return { trail, wrapper };
}

it('drops rows, cursor and the read in flight when the session changes, and starts again at page one', async () => {
  const session = ref<string | null>('user-a');
  const signals: AbortSignal[] = [];
  let resolvePending!: (value: ReturnType<typeof page>) => void;
  const fetcher = vi.fn((_query: Record<string, unknown>, signal?: AbortSignal) => {
    signals.push(signal as AbortSignal);
    if (fetcher.mock.calls.length === 2)
      return new Promise<ReturnType<typeof page>>((resolve) => {
        resolvePending = resolve;
      });
    return Promise.resolve(fetcher.mock.calls.length === 1 ? page(['a-1'], 'a-cursor') : page(['b-1']));
  });
  const { trail, wrapper } = mountTrail(() => useAuditTrailRequests(() => ({ query: { q: 'scope:server' }, fetcher, session: session.value })));
  await flushPromises();
  expect(trail.data.value.map((e) => e.id)).toEqual(['a-1']);
  const more = trail.loadMore();
  expect(fetcher.mock.calls[1]?.[0].cursor).toBe('a-cursor');
  session.value = 'user-b';
  await flushPromises();
  expect(signals[1]?.aborted).toBe(true);
  expect(fetcher.mock.calls[2]?.[0].cursor).toBeUndefined();
  resolvePending(page(['a-2'], 'a-cursor-2'));
  await more;
  await flushPromises();
  expect(trail.data.value.map((e) => e.id)).toEqual(['b-1']);
  expect(trail.nextCursor.value).toBeNull();
  // A session that is not a string or number is refused before any read.
  session.value = { id: 'x' } as unknown as string;
  await flushPromises();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(trail.error.value?.message).toMatch(/`session` must be a string or a number/);
  wrapper.unmount();
});

it('reads Vue reactive options with Date bounds and class getters through the boundary', async () => {
  class Scope {
    get tenant() {
      return 'acme';
    }
  }
  const fetcher = vi.fn().mockResolvedValue(page([]));
  const options = reactive(Object.assign(new Scope(), { fetcher, range: { from: new Date(ISO) } })) as unknown as AuditTrailOptions;
  const { wrapper } = mountTrail(() => useAuditTrail(options));
  await flushPromises();
  expect(fetcher.mock.lastCall?.[0]).toEqual({ q: 'tenant:"acme"', from: ISO });
  expect(Object.isFrozen(fetcher.mock.lastCall?.[0])).toBe(true);
  (options.range as { from: Date }).from = new Date('2026-11-05T00:00:00.000Z');
  await flushPromises();
  expect(fetcher.mock.lastCall?.[0].from).toBe('2026-11-05T00:00:00.000Z');
  wrapper.unmount();
});

it('never continues a cursor across trails that only a lying toJSON makes look alike', async () => {
  const lying = (from: string) => ({ from, toJSON: () => ({}) });
  const range = ref(lying(ISO));
  const fetcher = vi.fn().mockResolvedValue(page(['x'], 'next'));
  const { trail, wrapper } = mountTrail(() => useAuditTrail(() => ({ fetcher, tenant: 'acme', range: range.value })));
  await flushPromises();
  range.value = lying('2026-11-09T00:00:00.000Z');
  // loadMore before the watcher has run: the snapshot is a different trail, so it starts at page one.
  await trail.loadMore();
  expect(fetcher.mock.lastCall?.[0]).toEqual({ q: 'tenant:"acme"', from: '2026-11-09T00:00:00.000Z' });
  wrapper.unmount();
});

it('runs loadMore for a changed trail even while the old trail is loading or has no next page', async () => {
  const tenant = ref('acme');
  let release!: () => void;
  const fetcher = vi.fn(
    (query: Record<string, unknown>) =>
      new Promise<ReturnType<typeof page>>((resolve) => {
        if (query.q === 'tenant:"acme"') release = () => resolve(page(['acme-1']));
        else resolve(page(['globex-1']));
      }),
  );
  const { trail, wrapper } = mountTrail(() => useAuditTrail(() => ({ fetcher, tenant: tenant.value })));
  expect(trail.loading.value).toBe(true);
  tenant.value = 'globex';
  await trail.loadMore();
  expect(fetcher.mock.lastCall?.[0]).toEqual({ q: 'tenant:"globex"' });
  release();
  await flushPromises();
  expect(trail.data.value.map((e) => e.id)).toEqual(['globex-1']);
  // The trail on screen with no next page: loadMore does nothing.
  const calls = fetcher.mock.calls.length;
  await trail.loadMore();
  expect(fetcher).toHaveBeenCalledTimes(calls);
  wrapper.unmount();
});

// Round 4: two client instances sharing one prototype method must not share pagination through `this`.
it('calls the fetcher as a plain function, so a shared prototype method cannot carry a cursor across clients', async () => {
  class Client {
    constructor(readonly project: string) {}
    read(this: Client | undefined) {
      return Promise.resolve(page([`${this?.project ?? 'no-receiver'}-1`], 'next'));
    }
  }
  const a = new Client('a');
  const b = new Client('b');
  expect(a.read).toBe(b.read);
  const client = ref(a);
  const { trail, wrapper } = mountTrail(() => useAuditTrail(() => ({ tenant: 'acme', fetcher: client.value.read })));
  await flushPromises();
  // No receiver reaches the method: it cannot read one client's scope, and it cannot differ between the two.
  expect(trail.data.value.map((e) => e.id)).toEqual(['no-receiver-1']);
  wrapper.unmount();
});

it('reads nothing of the options beyond what the snapshot reads (no deep traversal)', async () => {
  const fetcher = vi.fn().mockResolvedValue(page([]));
  const profile = reactive({ loaded: false });
  const options = reactive({
    fetcher,
    tenant: 'acme',
    get avatar(): string {
      // Unrelated application state that throws while a profile loads.
      if (!profile.loaded) throw new Error('profile not loaded');
      return 'x';
    },
  });
  const { trail, wrapper } = mountTrail(() => useAuditTrail(options as unknown as AuditTrailOptions));
  await flushPromises();
  expect(trail.error.value).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
  wrapper.unmount();
});

it('invalidates synchronously on a session change: no old row, cursor or in-flight result is visible afterwards', async () => {
  const session = ref('user-a');
  let resolveA!: (value: Awaited<ReturnType<AuditFetcher>>) => void;
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn((query: Record<string, unknown>, signal?: AbortSignal) => {
    signals.push(signal as AbortSignal);
    if (fetcher.mock.calls.length === 1) return Promise.resolve(page(['a-1'], 'a-next'));
    if (query.cursor)
      return new Promise<Awaited<ReturnType<AuditFetcher>>>((resolve) => {
        resolveA = resolve;
      });
    return Promise.resolve(page(['b-1']));
  });
  const { trail, wrapper } = mountTrail(() => useAuditTrailRequests(() => ({ query: { q: 'scope:server' }, fetcher, session: session.value })));
  await flushPromises();
  const more = trail.loadMore();
  session.value = 'user-b';
  // Before any tick: the old rows, the cursor and the read in flight are gone.
  expect(trail.data.value).toEqual([]);
  expect(trail.nextCursor.value).toBeNull();
  expect(signals[1]?.aborted).toBe(true);
  // A's page arriving now is never published.
  resolveA(page(['a-2'], 'a-next-2'));
  await more;
  expect(trail.data.value.map((e) => e.id)).not.toContain('a-2');
  await flushPromises();
  expect(trail.data.value.map((e) => e.id)).toEqual(['b-1']);
  expect(fetcher).toHaveBeenCalledTimes(3);
  wrapper.unmount();
});

it('starts nothing after disposal, even from an abort listener that re-enters', async () => {
  let trail!: ReturnType<typeof useAuditTrail>;
  const fetcher = vi.fn((_query: Record<string, unknown>, signal?: AbortSignal) => {
    signal?.addEventListener('abort', () => {
      void trail.refresh();
      void trail.loadMore();
    });
    return new Promise<Awaited<ReturnType<AuditFetcher>>>(() => undefined);
  });
  const mounted = mountTrail(() => useAuditTrail(() => ({ fetcher, tenant: 'acme' })));
  trail = mounted.trail;
  await flushPromises();
  mounted.wrapper.unmount();
  await flushPromises();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('stays consistent when an abort listener re-enters the composable synchronously', async () => {
  let reentered = false;
  let trail!: ReturnType<typeof useAuditTrail>;
  const fetcher = vi.fn((_query: Record<string, unknown>, signal?: AbortSignal) => {
    const call = fetcher.mock.calls.length;
    signal?.addEventListener('abort', () => {
      if (!reentered) {
        reentered = true;
        void trail.refresh();
      }
    });
    return call === 1 ? new Promise<ReturnType<typeof page>>(() => undefined) : Promise.resolve(page([`row-${call}`]));
  });
  const mounted = mountTrail(() => useAuditTrail(() => ({ fetcher, tenant: 'acme' })));
  trail = mounted.trail;
  await trail.refresh();
  await flushPromises();
  expect(trail.loading.value).toBe(false);
  expect(trail.error.value).toBeUndefined();
  expect(trail.data.value).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  mounted.wrapper.unmount();
});

// Round 5: an abort listener that changes the options again while the composable invalidates must win.
it('lets the newest selection win when an abort listener changes the trail during invalidation', async () => {
  const tenant = ref('a');
  let switched = false;
  const fetcher = vi.fn((query: Record<string, unknown>, signal?: AbortSignal) => {
    if (query.q === 'tenant:"a"') {
      signal?.addEventListener('abort', () => {
        if (!switched) {
          switched = true;
          tenant.value = 'c';
        }
      });
      return new Promise<Awaited<ReturnType<AuditFetcher>>>(() => undefined);
    }
    return Promise.resolve(page([`${String(query.q)}-1`]));
  });
  const { trail, wrapper } = mountTrail(() => useAuditTrail(() => ({ fetcher, tenant: tenant.value })));
  tenant.value = 'b';
  await flushPromises();
  expect(fetcher.mock.calls.map((call) => call[0].q)).toEqual(['tenant:"a"', 'tenant:"c"']);
  expect(trail.data.value.map((e) => e.id)).toEqual(['tenant:"c"-1']);
  wrapper.unmount();
});
