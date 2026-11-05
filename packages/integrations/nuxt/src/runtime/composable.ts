import { type AuditTrailOptions, useAuditTrail as useVueAuditTrail } from '@trailmark/vue';
import { type MaybeRefOrGetter, toValue } from 'vue';
import { useRequestFetch } from '#imports';
export function useAuditTrail(options: MaybeRefOrGetter<Omit<AuditTrailOptions, 'fetcher'>>) {
  const fetcher = useRequestFetch();
  return useVueAuditTrail(() => ({ ...toValue(options), fetcher: (query, signal) => fetcher('/api/_trailmark/events', { query, signal }) }));
}
