// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const notices = vi.hoisted(() => ({
  loading: vi.fn((_title: string, _options: unknown) => 'qa-export-progress'),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: notices }));
vi.mock('@/lib/api/client', () => ({ api: { events: { exportUrl: () => '/qa-export' }, exportStatus: vi.fn() }, langParam: (lang: string) => lang }));

import { ExportMenu } from './explorer-toolbar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, host: HTMLDivElement | undefined;
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function start() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<ExportMenu projectId="qa-export" range="24h" q="" />));
  const button = host.querySelector<HTMLButtonElement>('[data-testid="export-menu"]');
  if (!button) throw new Error('Export button missing');
  act(() => button.click());
  await settle();
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes('Spreadsheet (CSV)'));
  if (!item) throw new Error('Spreadsheet menu item missing');
  act(() => item.click());
  await settle();
  return button;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('shows the waiting state and cancels the actual request without a generic failure toast', async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
        }),
    ),
  );
  const button = await start();
  expect(button.disabled).toBe(true);
  expect(notices.loading).toHaveBeenCalledWith(
    'Preparing export \u2014 waiting for active writes',
    expect.objectContaining({ cancel: expect.objectContaining({ label: 'Cancel' }) }),
  );
  const options = notices.loading.mock.calls[0]?.[1] as { cancel: { onClick: () => void } };
  act(() => options.cancel.onClick());
  await settle();
  expect(signal?.aborted).toBe(true);
  expect(notices.info).toHaveBeenCalledWith('Export canceled', expect.objectContaining({ id: 'qa-export-progress' }));
  expect(notices.error).not.toHaveBeenCalled();
  expect(button.disabled).toBe(false);
});
it('replaces the waiting notice with the server reason when preparation fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { code: 'export_project_busy', message: 'The project is processing writes. Retry the export.' } }, { status: 503 }),
      ),
  );
  const button = await start();
  expect(button.disabled).toBe(false);
  expect(notices.error).toHaveBeenCalledWith(
    'Export failed',
    expect.objectContaining({ id: 'qa-export-progress', description: expect.stringContaining('processing writes') }),
  );
});
it('replaces the waiting notice after a successful file download', async () => {
  const id = '9cfb85bf-1c6a-46d8-a8fe-3790d5f72d5d';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('id,timestamp\n', { headers: { 'X-Logbird-Export-Id': id } })));
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:qa-export');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  const button = await start();
  expect(button.disabled).toBe(false);
  expect(create).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledWith('blob:qa-export');
  expect(click).toHaveBeenCalledOnce();
  expect(notices.success).toHaveBeenCalledWith('Spreadsheet (CSV) ready', expect.objectContaining({ id: 'qa-export-progress' }));
});
