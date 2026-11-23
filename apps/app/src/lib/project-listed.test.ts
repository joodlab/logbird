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
