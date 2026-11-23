import {
  type SearchInput,
  type SearchQuery,
  type SearchResponse,
  type SearchSnapshot,
  searchKey,
  snapshotSearchQuery,
  type TrailQuery,
  trailQuery,
} from '@logbird/sdk/read';
import { defineComponent, type MaybeRefOrGetter, onScopeDispose, type PropType, shallowRef, toValue, watch } from 'vue';
export type AuditFetcher = (query: Partial<SearchQuery>, signal?: AbortSignal) => Promise<SearchResponse>;
/**
 * A string or number naming who is signed in (a user or session id). When it changes, the shown rows, the cursor and
 * any read in flight are dropped and the trail reloads from page one.
 */
export type AuditSession = string | number;
export interface AuditTrailOptions extends TrailQuery {
  /** Pass a stable function (defined once): rows and cursor belong to the fetcher that produced them. */
  fetcher: AuditFetcher;
  /** Pass it when the fetcher's scope follows the signed-in session; see `AuditSession`. */
  session?: AuditSession | null;
}
/** One read the composable can run: a complete query and the fetcher it is sent to. Its cursor is ignored. */
export interface AuditTrailRequest {
  query: SearchInput;
  fetcher: AuditFetcher;
  session?: AuditSession | null;
}
/** Error conversion that cannot itself throw (a thrown null-prototype object has no toString). */
function asError(cause: unknown): Error {
  try {
    if (cause instanceof Error) return cause;
    return new Error(String(cause));
  } catch {
    return new Error('The audit trail could not be read.');
  }
}
function sessionKey(value: unknown): AuditSession | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new TypeError('useAuditTrail: `session` must be a string or a number.');
}
/** A request as read from the caller, each property once. */
type RawRequest = { query: unknown; fetcher: unknown; session: unknown };
/** A request after the boundary: the query is a frozen snapshot of primitives, and `key` is its canonical form. */
type Read = { key: string; query: SearchSnapshot; fetcher: AuditFetcher };
type State = Read | { error: Error };

function createTrail(source: () => RawRequest) {
  const data = shallowRef<SearchResponse['data']>([]);
  const loading = shallowRef(false);
  const error = shallowRef<Error>();
  const nextCursor = shallowRef<string | null>(null);
  let generation = 0;
  let disposed = false;
  let controller: AbortController | undefined;
  /** The newest state a change queued for the next tick's read. */
  let pending: State | undefined;
  let scheduled = false;
  /** Bumped by every change: a callback that a nested change overtook (say, from an abort listener) stands down. */
  let selection = 0;
  /** What the shown rows and cursor belong to; a different trail, session or fetcher never continues them. */
  let owner: { key: string; fetcher: AuditFetcher } | undefined;
  const snapshot = (): State => {
    try {
      const request = source();
      const fetcher = request.fetcher;
      if (typeof fetcher !== 'function') throw new TypeError('useAuditTrail: `fetcher` must be a function.');
      // The boundary: from here on only this snapshot is used. Page one never carries a cursor, not even the caller's.
      const { cursor: _cursor, ...query } = snapshotSearchQuery(request.query as SearchInput, 'useAuditTrail');
      const session = sessionKey(request.session);
      return { key: JSON.stringify([searchKey(query), session]), query: Object.freeze(query), fetcher: fetcher as AuditFetcher };
    } catch (cause) {
      return { error: asError(cause) };
    }
  };
  const clear = () => {
    data.value = [];
    nextCursor.value = null;
    owner = undefined;
  };
  const owns = (state: State) => !('error' in state) && owner !== undefined && owner.key === state.key && owner.fetcher === state.fetcher;
  /** Nothing in flight may publish any more, and nothing on screen belongs to the current trail. */
  const invalidate = () => {
    generation++;
    const previous = controller;
    controller = undefined;
    clear();
    previous?.abort();
  };
  async function run(state: State, append: boolean) {
    if (disposed) return;
    // Any explicit or queued run reads the current snapshot, so it supersedes older queued work.
    pending = undefined;
    const current = ++generation;
    const previous = controller;
    const mine = new AbortController();
    controller = mine;
    previous?.abort();
    // An abort listener may have started a newer run (or disposed the scope) synchronously: that wins.
    if (current !== generation || disposed) return;
    error.value = undefined;
    if ('error' in state) {
      // An incomplete trail (a tenant id not loaded yet) or failing options: an error, never a wider read (#263).
      clear();
      error.value = state.error;
      loading.value = false;
      return;
    }
    const cursor = append && owns(state) ? nextCursor.value : null;
    if (!cursor) clear();
    owner = { key: state.key, fetcher: state.fetcher };
    const query = cursor ? Object.freeze({ ...state.query, cursor }) : state.query;
    loading.value = true;
    try {
      // A plain call: the fetcher cannot read a different scope through `this`.
      const fetcher = state.fetcher;
      const page = await fetcher(query, mine.signal);
      if (current !== generation) return;
      const unique = new Map((cursor ? data.value : []).map((event) => [event.id, event]));
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
  const loadMore = () => {
    if (disposed) return Promise.resolve();
    const state = snapshot();
    // Nothing more to load for the trail on screen. A changed trail, session or fetcher (or an invalid one) always runs,
    // restarting at page one or showing the error.
    if (owns(state) && (!nextCursor.value || loading.value)) return Promise.resolve();
    return run(state, true);
  };
  // The watcher reads only what the snapshot reads (no deep traversal of the caller's options). It runs synchronously
  // on every change: a changed trail, session or fetcher invalidates at once (rows, cursor and the read in flight go
  // before any other code can see them), and the new read is batched to one request per tick.
  let first = true;
  watch(
    snapshot,
    (state) => {
      if (first) {
        first = false;
        void run(state, false);
        return;
      }
      if (disposed || owns(state)) return;
      const mine = ++selection;
      invalidate();
      // invalidate() aborts the read in flight, and an abort listener may have changed the options again: the newer
      // callback has already queued its own state, so this older one must not overwrite it.
      if (mine !== selection || disposed) return;
      loading.value = !('error' in state);
      pending = state;
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        const next = pending;
        if (next !== undefined) void run(next, false);
      });
    },
    { immediate: true, flush: 'sync' },
  );
  onScopeDispose(() => {
    disposed = true;
    generation++;
    controller?.abort();
  });
  return { data, loading, error, nextCursor, refresh, loadMore };
}

/**
 * The composable's engine, for callers that build the query themselves: `source` returns the complete query and the
 * fetcher for it. It applies no selector checks of its own, exactly like calling the fetcher yourself; the Nuxt
 * integration uses it because its fixed read route decides the scope on the server. Use `useAuditTrail` otherwise.
 * The fetcher is called as a plain function (no `this`).
 */
export function useAuditTrailRequests(source: () => AuditTrailRequest) {
  return createTrail(() => {
    const request = source();
    return { query: request.query, fetcher: request.fetcher, session: request.session };
  });
}

/**
 * A record's, actor's or tenant's trail. The query is built by `trailQuery`, so it never reads wider than asked (#263).
 * The fetcher is called as a plain function (no `this`): pass a function, or a method bound once.
 */
export function useAuditTrail(options: MaybeRefOrGetter<AuditTrailOptions>) {
  return createTrail(() => {
    const input = toValue(options);
    return { query: trailQuery(input), fetcher: input.fetcher, session: input.session };
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
