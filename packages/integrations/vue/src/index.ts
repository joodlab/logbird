import { type SearchQuery, type SearchResponse, type TrailQuery, trailQuery } from '@logbird/sdk/read';
import { defineComponent, type MaybeRefOrGetter, onScopeDispose, type PropType, shallowRef, toValue, watch } from 'vue';
export type AuditFetcher = (query: Partial<SearchQuery>, signal?: AbortSignal) => Promise<SearchResponse>;
export interface AuditTrailOptions extends TrailQuery {
  fetcher: AuditFetcher;
}
export function useAuditTrail(options: MaybeRefOrGetter<AuditTrailOptions>) {
  const data = shallowRef<SearchResponse['data']>([]);
  const loading = shallowRef(false);
  const error = shallowRef<Error>();
  const nextCursor = shallowRef<string | null>(null);
  let generation = 0;
  let controller: AbortController | undefined;
  async function load(append: boolean) {
    const current = ++generation;
    controller?.abort();
    controller = new AbortController();
    error.value = undefined;
    if (!append) {
      data.value = [];
      nextCursor.value = null;
    }
    const input = toValue(options);
    let query: Partial<SearchQuery>;
    try {
      query = trailQuery({ ...input, cursor: append ? (nextCursor.value ?? undefined) : undefined });
    } catch (cause) {
      // An incomplete trail (say, a tenant id not loaded yet) is an error, never a wider read: nothing is fetched (#263).
      error.value = cause instanceof Error ? cause : new Error(String(cause));
      loading.value = false;
      return;
    }
    loading.value = true;
    try {
      const page = await input.fetcher(query, controller.signal);
      if (current !== generation) return;
      const unique = new Map((append ? data.value : []).map((event) => [event.id, event]));
      for (const event of page.data) unique.set(event.id, event);
      data.value = [...unique.values()];
      nextCursor.value = page.nextCursor;
    } catch (cause) {
      if (current === generation) error.value = cause instanceof Error ? cause : new Error(String(cause));
    } finally {
      if (current === generation) loading.value = false;
    }
  }
  const refresh = () => load(false);
  const loadMore = () => (nextCursor.value && !loading.value ? load(true) : Promise.resolve());
  // Watches the trail's query, or why it cannot be built; load() then reports that error without fetching.
  watch(
    () => {
      try {
        return trailQuery(toValue(options));
      } catch (cause) {
        return { invalid: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    refresh,
    { immediate: true, deep: true },
  );
  onScopeDispose(() => {
    generation++;
    controller?.abort();
  });
  return { data, loading, error, nextCursor, refresh, loadMore };
}
export const AuditTimeline = defineComponent({
  name: 'AuditTimeline',
  props: { options: { type: Object as PropType<AuditTrailOptions>, required: true } },
  setup(props, { slots }) {
    const trail = useAuditTrail(() => props.options);
    return () => slots.default?.(trail);
  },
});
