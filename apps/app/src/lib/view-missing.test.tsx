// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { useConfirmedMissingView } from './views';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Renders the view-list query and the hook the explorer route uses; reports what the route would decide. */
async function open(cached: string[], server: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 20_000, retry: false } } });
  // A list cached a moment ago (still fresh) that does not have the linked view.
  client.setQueryData(['views'], cached);
  let fetches = 0;
  const seen: { found: boolean; confirmedMissing: boolean }[] = [];
  function Probe() {
    const views = useQuery({
      queryKey: ['views'],
      queryFn: async () => {
        fetches++;
        return server;
      },
    });
    const found = Boolean(views.data?.includes('v1'));
    const confirmedMissing = useConfirmedMissingView(views, 'v1', found);
    seen.push({ found, confirmedMissing });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    await settle();
  });
  await act(settle);
  root.unmount();
  return { fetches, seen };
}

it('fetches a fresh cached list once more when the linked view is missing, and finds a view that exists', async () => {
  const { fetches, seen } = await open([], ['v1']);
  expect(fetches).toBe(1);
  // Never "confirmed missing" on the way: the route keeps holding until the view arrives.
  expect(seen.some((s) => s.confirmedMissing)).toBe(false);
  expect(seen.at(-1)).toEqual({ found: true, confirmedMissing: false });
});

it('confirms a view gone only after that fresh fetch', async () => {
  const { fetches, seen } = await open([], []);
  expect(fetches).toBe(1);
  expect(seen[0]).toEqual({ found: false, confirmedMissing: false });
  expect(seen.at(-1)).toEqual({ found: false, confirmedMissing: true });
});

it('does not refetch when the cached list already has the view', async () => {
  const { fetches, seen } = await open(['v1'], ['v1']);
  expect(fetches).toBe(0);
  expect(seen.every((s) => s.found && !s.confirmedMissing)).toBe(true);
});
