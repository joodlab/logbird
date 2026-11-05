// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
import { h, ref } from 'vue';
import { useAuditTrail } from './index';

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
