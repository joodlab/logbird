// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, it } from 'vitest';
import { useConfirmedMissingView } from './views';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

type Seen = { project: string; found: boolean; confirmedMissing: boolean };

/** The view-list query and the hook as the explorer route uses them, per project; records what the route would decide. */
function harness(server: Record<string, { views: string[]; delayMs?: number }>) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 20_000, retry: false } } });
  const fetches: string[] = [];
  const seen: Seen[] = [];
  function Probe({ project }: { project: string }) {
    const views = useQuery({
      queryKey: ['views', project],
      queryFn: async () => {
        fetches.push(project);
        await settle(server[project]?.delayMs ?? 0);
        return server[project]?.views ?? [];
      },
    });
    const found = Boolean(views.data?.includes('v1'));
    const confirmedMissing = useConfirmedMissingView(views, project, 'v1', found);
    seen.push({ project, found, confirmedMissing });
    return null;
  }
  let root: Root | undefined;
  const render = async (project: string, wait = 20) => {
    root ??= createRoot(document.createElement('div'));
    await act(async () => {
      root?.render(
        <QueryClientProvider client={client}>
          <Probe project={project} />
        </QueryClientProvider>,
      );
      await settle(wait);
    });
  };
  return { client, fetches, seen, render, unmount: () => root?.unmount() };
}

it('fetches a fresh cached list once more when the linked view is missing, and finds a view that exists', async () => {
  const h = harness({ A: { views: ['v1'] } });
  // A list cached a moment ago (still fresh) that does not have the linked view.
  h.client.setQueryData(['views', 'A'], []);
  await h.render('A');
  await act(() => settle());
  h.unmount();
  expect(h.fetches).toEqual(['A']);
  // Never "confirmed missing" on the way: the route keeps holding until the view arrives.
  expect(h.seen.some((s) => s.confirmedMissing)).toBe(false);
  expect(h.seen.at(-1)).toEqual({ project: 'A', found: true, confirmedMissing: false });
});

it('confirms a view gone only after that fresh fetch', async () => {
  const h = harness({ A: { views: [] } });
  h.client.setQueryData(['views', 'A'], []);
  await h.render('A');
  await act(() => settle());
  h.unmount();
  expect(h.fetches).toEqual(['A']);
  expect(h.seen[0]).toEqual({ project: 'A', found: false, confirmedMissing: false });
  expect(h.seen.at(-1)).toEqual({ project: 'A', found: false, confirmedMissing: true });
});

it('does not refetch when the cached list already has the view', async () => {
  const h = harness({ A: { views: ['v1'] } });
  h.client.setQueryData(['views', 'A'], ['v1']);
  await h.render('A');
  h.unmount();
  expect(h.fetches).toEqual([]);
  expect(h.seen.every((s) => s.found && !s.confirmedMissing)).toBe(true);
});

it("never lets one project's confirmation release another project's link with the same view id", async () => {
  const h = harness({ A: { views: [] }, B: { views: ['v1'], delayMs: 200 } });
  h.client.setQueryData(['views', 'A'], []);
  await h.render('A');
  await act(() => settle());
  expect(h.seen.at(-1)).toEqual({ project: 'A', found: false, confirmedMissing: true });
  // Same mounted route, now project B, whose list is still loading.
  await h.render('B', 20);
  const whileLoading = h.seen.filter((s) => s.project === 'B');
  expect(whileLoading.length).toBeGreaterThan(0);
  expect(whileLoading.every((s) => !s.confirmedMissing)).toBe(true);
  await act(() => settle(250));
  h.unmount();
  expect(h.seen.at(-1)).toEqual({ project: 'B', found: true, confirmedMissing: false });
});

it("keeps this project's confirmation when another project's late answer arrives", async () => {
  const h = harness({ A: { views: [], delayMs: 150 }, B: { views: [] } });
  h.client.setQueryData(['views', 'A'], []);
  h.client.setQueryData(['views', 'B'], []);
  // A starts its confirmation fetch; the reader moves to B before A answers; B confirms its own.
  await h.render('A', 5);
  await h.render('B', 40);
  expect(h.seen.at(-1)).toEqual({ project: 'B', found: false, confirmedMissing: true });
  // A's late answer adds its own confirmation and must not undo B's (no hold again, no extra fetch for B).
  await act(() => settle(200));
  h.unmount();
  const afterB = h.seen.slice(h.seen.findIndex((s) => s.project === 'B' && s.confirmedMissing));
  expect(afterB.every((s) => s.confirmedMissing)).toBe(true);
  expect(h.fetches.filter((p) => p === 'B')).toEqual(['B']);
});
