import { QueryClient } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';

const list = vi.fn();
vi.mock('@/lib/api/client', () => ({ api: { projects: { list: () => list() } } }));

const { projectIsListed } = await import('./project-listed');
const { keys } = await import('./api/queries');

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
beforeEach(() => list.mockReset());

it('opens a project created since the list was cached: missing from the cache, present after the refetch', async () => {
  const queryClient = client();
  // The list was read a moment ago (well inside its 30 s staleTime), before the project existed.
  queryClient.setQueryData(keys.projects, [{ id: 'proj_old', name: 'Old' }]);
  list.mockResolvedValueOnce([
    { id: 'proj_old', name: 'Old' },
    { id: 'proj_new', name: 'Created in another tab' },
  ]);
  expect(await projectIsListed(queryClient, 'proj_new')).toBe(true);
  expect(list).toHaveBeenCalledTimes(1);
});

it('is not found only when the fresh list lacks it too (a deleted or foreign project)', async () => {
  const queryClient = client();
  queryClient.setQueryData(keys.projects, [{ id: 'proj_deleted', name: 'Deleted since' }]);
  expect(await projectIsListed(queryClient, 'proj_deleted')).toBe(true);
  list.mockResolvedValueOnce([{ id: 'proj_old', name: 'Old' }]);
  expect(await projectIsListed(queryClient, 'proj_foreign')).toBe(false);
  expect(list).toHaveBeenCalledTimes(1);
});

it('reads the cache alone when it already lists the project', async () => {
  const queryClient = client();
  queryClient.setQueryData(keys.projects, [{ id: 'proj_a', name: 'A' }]);
  expect(await projectIsListed(queryClient, 'proj_a')).toBe(true);
  expect(list).not.toHaveBeenCalled();
});

it('leaves the decision to the project request when the list cannot be read', async () => {
  list.mockRejectedValueOnce(new Error('offline'));
  expect(await projectIsListed(client(), 'proj_a')).toBe(true);
});

it('settles a cold visit with one list read: an id the just-read list lacks is not found without reading it again', async () => {
  list.mockResolvedValueOnce([{ id: 'proj_a', name: 'A' }]);
  expect(await projectIsListed(client(), 'proj_stale_link')).toBe(false);
  expect(list).toHaveBeenCalledTimes(1);
});

it('answers from a stale cached list at once and refreshes it in the background', async () => {
  const queryClient = client();
  queryClient.setQueryData(keys.projects, [{ id: 'proj_a', name: 'A' }], { updatedAt: Date.now() - 60_000 });
  list.mockResolvedValueOnce([{ id: 'proj_a', name: 'A renamed' }]);
  expect(await projectIsListed(queryClient, 'proj_a')).toBe(true);
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
});

it('reads the cache when a refresh already in flight lands first, so a project that list holds still opens', async () => {
  const queryClient = client();
  queryClient.setQueryData(keys.projects, [{ id: 'proj_a', name: 'A' }], { updatedAt: Date.now() - 60_000 });
  // A background refresh is already running; it lands with the new project while the check waits.
  let land: (v: unknown) => void = () => undefined;
  list.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
  const refresh = queryClient.fetchQuery({ queryKey: keys.projects, queryFn: () => list(), staleTime: 0 });
  const check = projectIsListed(queryClient, 'proj_new');
  land([
    { id: 'proj_a', name: 'A' },
    { id: 'proj_new', name: 'New' },
  ]);
  await refresh;
  expect(await check).toBe(true);
});
