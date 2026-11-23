import { type AuditTrailOptions, useAuditTrail as useVueAuditTrail } from '@logbird/vue';
import { type MaybeRefOrGetter, toValue } from 'vue';
import { useRequestFetch } from '#imports';
export function useAuditTrail(options: MaybeRefOrGetter<Omit<AuditTrailOptions, 'fetcher'>>) {
  const fetcher = useRequestFetch();
  // The read route's authorize hook decides the scope on the server, so an empty client trail is allowed here; a
  // selector passed without a value still throws on the client (#263).
  // Layered over the caller's options (not spread), so inherited or non-enumerable selectors still count.
  return useVueAuditTrail(() =>
    Object.assign(Object.create(toValue(options)) as AuditTrailOptions, {
      scopedByServer: true,
      fetcher: ((query, signal) => fetcher('/api/_logbird/events', { query, signal })) as AuditTrailOptions['fetcher'],
    }),
  );
}
