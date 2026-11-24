import { QueryClient } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';

const list = vi.fn();
const get = vi.fn();
// The session as the server has it now: Labs open (another tab switched it), member of Clinics and Labs.
const me = vi.fn(async () => ({
  user: { id: 'u_lina', name: 'Lina', email: 'lina@example.invalid', image: null },
  organizations: [
    { id: 'ws_clinics', name: 'Clinics Example', slug: 'clinics', role: 'member' },
    { id: 'ws_labs', name: 'Labs Example', slug: 'labs', role: 'owner' },
  ],
  activeOrganizationId: 'ws_labs',
}));
vi.mock('@/lib/auth-client', () => ({ authClient: { getSession: async () => ({ data: { session: {} }, error: null }) } }));
vi.mock('@/lib/api/client', () => ({ api: { me: () => me(), projects: { list: () => list(), get: (id: string) => get(id) } } }));

const { confirmedProject, PROJECT_MISSING, projectElsewhere, projectIsListed, readProject } = await import('./project-listed');
const { ApiRequestError } = await import('./api/errors');
const { keys } = await import('./api/queries');

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
beforeEach(() => {
  list.mockReset();
  get.mockReset();
});

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
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        land = resolve;
      }),
  );
  const refresh = queryClient.fetchQuery({ queryKey: keys.projects, queryFn: () => list(), staleTime: 0 });
  const check = projectIsListed(queryClient, 'proj_new');
  land([
    { id: 'proj_a', name: 'A' },
    { id: 'proj_new', name: 'New' },
  ]);
  await refresh;
  expect(await check).toBe(true);
});

const elsewhere = () =>
  new ApiRequestError(409, 'project_in_other_workspace', 'This project is in Clinics Example.', {
    workspaceId: 'ws_clinics',
    workspaceName: 'Clinics Example',
  });

it('names the workspace a project is in only from a well-formed 409 project_in_other_workspace', () => {
  expect(projectElsewhere(elsewhere())).toEqual({ kind: 'project-elsewhere', workspaceId: 'ws_clinics', workspaceName: 'Clinics Example' });
  expect(projectElsewhere(new ApiRequestError(404, 'not_found', 'Project not found.'))).toBeNull();
  expect(projectElsewhere(new ApiRequestError(409, 'project_in_other_workspace', 'x', { workspaceId: 'ws_clinics' }))).toBeNull();
  expect(projectElsewhere(new ApiRequestError(409, 'webhook_secret_overlap_limit', 'x', { workspaceId: 'a', workspaceName: 'b' }))).toBeNull();
  expect(projectElsewhere(new Error('offline'))).toBeNull();
});

it('reads a project fresh on entry: readable, in another of my workspaces, missing, or a failure to retry', async () => {
  const qc = client();
  const project = { id: 'p_clinics', name: 'Clinics', organizationId: 'ws_clinics' };
  // A stale detail another workspace left in the cache never answers: the read goes to the server.
  qc.setQueryData(keys.project('p_clinics').concat('detail'), project);
  get.mockResolvedValueOnce(project);
  expect(await readProject(qc, 'p_clinics')).toBe('readable');
  expect(get).toHaveBeenCalledTimes(1);
  // Only this project id counts as confirmed: another id is read fresh on entry, even when the router calls it 'stay'.
  expect(confirmedProject(qc)).toBe('p_clinics');
  get.mockRejectedValueOnce(elsewhere());
  // The prompt names the workspace the session really has open, read fresh, not this tab's idea of it.
  expect(await readProject(qc, 'p_clinics')).toEqual({
    kind: 'project-elsewhere',
    workspaceId: 'ws_clinics',
    workspaceName: 'Clinics Example',
    openWorkspaceName: 'Labs Example',
  });
  // A refused read forgets the confirmed project, so moving to it again reads it again.
  expect(confirmedProject(qc)).toBeUndefined();
  get.mockRejectedValueOnce(new ApiRequestError(404, 'not_found', 'Project not found.'));
  expect(await readProject(qc, 'p_gone')).toBe(PROJECT_MISSING);
  // Offline or a 5xx is not "not found": it is thrown for the page's retry.
  // (Network failures are retried by the project query first, so these answers persist.)
  vi.useFakeTimers();
  try {
    for (const [id, failure, text] of [
      ['p_offline', new Error('offline'), 'offline'],
      ['p_down', new ApiRequestError(503, 'unavailable', 'Down'), 'Down'],
    ] as const) {
      get.mockRejectedValue(failure);
      const outcome = expect(readProject(qc, id)).rejects.toThrow(text);
      await vi.runAllTimersAsync();
      await outcome;
    }
  } finally {
    vi.useRealTimers();
  }
});
