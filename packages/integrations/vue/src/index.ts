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
    loading.value = true;
    error.value = undefined;
    if (!append) {
      data.value = [];
      nextCursor.value = null;
    }
    try {
      const input = toValue(options);
      const page = await input.fetcher(trailQuery({ ...input, cursor: append ? (nextCursor.value ?? undefined) : undefined }), controller.signal);
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
  watch(() => trailQuery(toValue(options)), refresh, { immediate: true, deep: true });
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
