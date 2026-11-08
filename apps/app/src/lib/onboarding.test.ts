import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

const list = vi.fn();
vi.mock('@/lib/api/client', () => ({ api: { projects: { list: () => list() } } }));

const { activeWorkspaceHasProjects } = await import('./onboarding');
const { keys } = await import('./api/queries');

describe('first-project wizard after creating or switching a workspace', () => {
  it('ignores a fresh-looking project list cached for the previous workspace', async () => {
    const queryClient = new QueryClient();
    // The shell fetched workspace A's projects a moment ago (well inside the 30 s staleTime)…
    queryClient.setQueryData(keys.projects, [{ id: 'proj_a', name: 'Workspace A project' }]);
    // …then the person created workspace B, which has no project yet.
    list.mockResolvedValueOnce([]);
    expect(await activeWorkspaceHasProjects(queryClient)).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('sends established workspaces to the in-shell dialog', async () => {
    list.mockResolvedValueOnce([{ id: 'proj_b', name: 'Workspace B project' }]);
    expect(await activeWorkspaceHasProjects(new QueryClient())).toBe(true);
  });

  it('keeps the wizard reachable when the list cannot be read', async () => {
    list.mockRejectedValueOnce(new Error('offline'));
    expect(await activeWorkspaceHasProjects(new QueryClient({ defaultOptions: { queries: { retry: false } } }))).toBe(false);
  });
});
