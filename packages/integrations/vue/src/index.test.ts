// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
import { h, ref } from 'vue';
import { type AuditTrailOptions, useAuditTrail, useAuditTrailRequests } from './index';

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
