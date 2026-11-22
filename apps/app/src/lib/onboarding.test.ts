import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { firstEventCopy } from './onboarding';

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

describe('firstEventCopy', () => {
  it('never claims the integration works for a console test event, in the toast or the card', () => {
    const copy = firstEventCopy('logbird-test');
    expect(copy).toEqual({
      toastTitle: 'Console test received',
      toastDescription: 'Logbird is receiving events. Send one from your backend to check your integration.',
      cardTitle: 'Console test received — now send one from your backend',
    });
    expect(Object.values(copy).join(' ')).not.toMatch(/works/i);
  });

  it('celebrates an integration event', () => {
    expect(firstEventCopy('booking-service').cardTitle).toBe('It works — your first event just arrived');
    // Once the backend has sent events, the console test card stops asking for one.
    expect(firstEventCopy('logbird-test', false, true).cardTitle).toBe('Console test received — your backend has sent events since');
    // Another Logbird-generated source is not called a console test.
    expect(firstEventCopy('logbird-import').cardTitle).toBe('Event from Logbird received — now send one from your backend');
    expect(firstEventCopy(null, false).cardTitle).toBe('First event received');
  });
});
