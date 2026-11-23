import { type SearchQuery, type SearchResponse, type TrailQuery, trailQuery } from '@logbird/sdk/read';
import { defineComponent, type MaybeRefOrGetter, onScopeDispose, type PropType, shallowRef, toValue, watch } from 'vue';
export type AuditFetcher = (query: Partial<SearchQuery>, signal?: AbortSignal) => Promise<SearchResponse>;
export interface AuditTrailOptions extends TrailQuery {
  fetcher: AuditFetcher;
  /** The fetcher's own server decides the scope (Nuxt's read route); see TrailQueryOptions.scopedByServer. */
  scopedByServer?: boolean;
}
const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));
export function useAuditTrail(options: MaybeRefOrGetter<AuditTrailOptions>) {
  const data = shallowRef<SearchResponse['data']>([]);
  const loading = shallowRef(false);
  const error = shallowRef<Error>();
  const nextCursor = shallowRef<string | null>(null);
  let generation = 0;
  let controller: AbortController | undefined;
  /** Builds the trail's query from the options, reading each value once (never through an object spread). */
  const build = () => {
    const input = toValue(options);
    return { input, query: trailQuery(input, { scopedByServer: Boolean(input?.scopedByServer) }) };
  };
  async function load(append: boolean) {
    const current = ++generation;
    controller?.abort();
    controller = new AbortController();
    error.value = undefined;
    if (!append) {
      data.value = [];
      nextCursor.value = null;
    }
    let built: ReturnType<typeof build>;
    try {
      built = build();
    } catch (cause) {
      // An incomplete trail (a tenant id not loaded yet) or failing options: an error, never a wider read. Nothing is
      // fetched, the earlier rows and cursor go too, and loading ends (#263).
      error.value = asError(cause);
      data.value = [];
      nextCursor.value = null;
      loading.value = false;
      return;
    }
    const query = append ? { ...built.query, cursor: nextCursor.value ?? undefined } : built.query;
    loading.value = true;
    try {
      const page = await built.input.fetcher(query, controller.signal);
      if (current !== generation) return;
      const unique = new Map((append ? data.value : []).map((event) => [event.id, event]));
      for (const event of page.data) unique.set(event.id, event);
      data.value = [...unique.values()];
      nextCursor.value = page.nextCursor;
    } catch (cause) {
      if (current === generation) error.value = asError(cause);
    } finally {
      if (current === generation) loading.value = false;
    }
  }
  const refresh = () => load(false);
  const loadMore = () => (nextCursor.value && !loading.value ? load(true) : Promise.resolve());
  // Watches the trail's query, or why it cannot be built; load() then reports that error without fetching. The
  // selectors are read with `in`, so Vue also tracks a selector key added to reactive options later.
  watch(
    () => {
      try {
        return build().query;
      } catch (cause) {
        return { invalid: asError(cause).message };
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
