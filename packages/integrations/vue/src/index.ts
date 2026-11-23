import { type SearchQuery, type SearchResponse, type TrailQuery, trailQuery } from '@logbird/sdk/read';
import { defineComponent, type MaybeRefOrGetter, onScopeDispose, type PropType, shallowRef, toValue, watch } from 'vue';
export type AuditFetcher = (query: Partial<SearchQuery>, signal?: AbortSignal) => Promise<SearchResponse>;
export interface AuditTrailOptions extends TrailQuery {
  /** Pass a stable function (defined once): rows and cursor belong to the fetcher that produced them. */
  fetcher: AuditFetcher;
}
/** One read the composable can run: a complete query (no cursor) and the fetcher it is sent to. */
export interface AuditTrailRequest {
  query: Partial<SearchQuery>;
  fetcher: AuditFetcher;
}
/** Error conversion that cannot itself throw (a thrown null-prototype object has no toString). */
function asError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  try {
    return new Error(String(cause));
  } catch {
    return new Error('The audit trail could not be read.');
  }
}
type Snapshot = { key: string; query: Partial<SearchQuery>; fetcher: AuditFetcher } | { error: Error };

/**
 * The composable's engine, for callers that build the query themselves: `source` returns the complete query and the
 * fetcher for it. It applies no selector checks of its own, exactly like calling the fetcher yourself; the Nuxt
 * integration uses it because its fixed read route decides the scope on the server. Use `useAuditTrail` otherwise.
 */
export function useAuditTrailRequests(source: () => AuditTrailRequest) {
  const data = shallowRef<SearchResponse['data']>([]);
  const loading = shallowRef(false);
  const error = shallowRef<Error>();
  const nextCursor = shallowRef<string | null>(null);
  let generation = 0;
  let controller: AbortController | undefined;
  /** What the shown rows and cursor belong to; a different trail or fetcher never continues them. */
  let owner: { key: string; fetcher: AuditFetcher } | undefined;
  const snapshot = (): Snapshot => {
    try {
      const request = source();
      const { cursor: _cursor, ...query } = request.query;
      return { key: JSON.stringify(query), query, fetcher: request.fetcher };
    } catch (cause) {
      return { error: asError(cause) };
    }
  };
  const clear = () => {
    data.value = [];
    nextCursor.value = null;
    owner = undefined;
  };
  async function run(state: Snapshot, append: boolean) {
    const current = ++generation;
    controller?.abort();
    controller = new AbortController();
    error.value = undefined;
    if ('error' in state) {
      // An incomplete trail (a tenant id not loaded yet) or failing options: an error, never a wider read (#263).
      clear();
      error.value = state.error;
      loading.value = false;
      return;
    }
    const continues = append && owner !== undefined && owner.key === state.key && owner.fetcher === state.fetcher;
    if (!continues) clear();
    owner = { key: state.key, fetcher: state.fetcher };
    // Page one never carries a cursor (not even one in the caller's options); later pages carry ours.
    const query = continues ? { ...state.query, cursor: nextCursor.value ?? undefined } : state.query;
    loading.value = true;
    try {
      const page = await state.fetcher(query, controller.signal);
      if (current !== generation) return;
      const unique = new Map((continues ? data.value : []).map((event) => [event.id, event]));
      for (const event of page.data) unique.set(event.id, event);
      data.value = [...unique.values()];
      nextCursor.value = page.nextCursor;
    } catch (cause) {
      if (current === generation) {
        // A failed or refused read leaves nothing of this trail on screen.
        clear();
        error.value = asError(cause);
      }
    } finally {
      if (current === generation) loading.value = false;
    }
  }
  const refresh = () => run(snapshot(), false);
  const loadMore = () => (nextCursor.value && !loading.value ? run(snapshot(), true) : Promise.resolve());
  // The callback runs exactly the snapshot the watcher validated (never a second read of the options).
  watch(snapshot, (state) => run(state, false), { immediate: true, deep: true });
  onScopeDispose(() => {
    generation++;
    controller?.abort();
  });
  return { data, loading, error, nextCursor, refresh, loadMore };
}

/** A record's, actor's or tenant's trail. The query is built by `trailQuery`, so it never reads wider than asked (#263). */
export function useAuditTrail(options: MaybeRefOrGetter<AuditTrailOptions>) {
  return useAuditTrailRequests(() => {
    const input = toValue(options);
    return { query: trailQuery(input), fetcher: input.fetcher };
  });
}
export const AuditTimeline = defineComponent({
  name: 'AuditTimeline',
  props: { options: { type: Object as PropType<AuditTrailOptions>, required: true } },
  setup(props, { slots }) {
    const trail = useAuditTrail(() => props.options);
    return () => slots.default?.(trail);
  },
});
