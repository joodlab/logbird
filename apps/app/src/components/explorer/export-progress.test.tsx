// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Toaster, toast } from 'sonner';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', () => ({ api: { events: { exportUrl: () => '/qa-export' }, exportStatus: vi.fn() }, langParam: (lang: string) => lang }));

import { ExportMenu } from './explorer-toolbar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, host: HTMLDivElement | undefined;
async function settle(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
async function start() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <>
        <ExportMenu projectId="qa-export" range="24h" q="" />
        <Toaster />
      </>,
    ),
  );
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
afterEach(async () => {
  act(() => toast.dismiss());
  await settle(400);
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('uses the real Sonner Cancel button and preserves the new confirmation beyond its old toast exit', async () => {
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
  expect(document.body.textContent).toContain('Preparing export…');
  expect(document.body.textContent).not.toContain('waiting for');
  await settle(1100);
  expect(document.body.textContent).toContain('waiting for server');
  expect(document.body.textContent).toContain('up to 30 seconds');
  const cancel = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Cancel');
  if (!cancel) throw new Error('Actual Sonner Cancel missing');
  act(() => cancel.click());
  await settle(700);
  expect(signal?.aborted).toBe(true);
  expect(document.body.textContent).toContain('Export canceled');
  expect(document.body.textContent).not.toContain('Export failed');
  expect(button.disabled).toBe(false);
});
it('shows the safe server reason when preparation fails', async () => {
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
  expect(document.body.textContent).toContain('Export failed');
  expect(document.body.textContent).toContain('processing writes');
});
it('changes to Downloading on headers, without a waiting notice during a slow body', async () => {
  const id = '9cfb85bf-1c6a-46d8-a8fe-3790d5f72d5d';
  let finish: (blob: Blob) => void = () => undefined;
  const response = new Response('', { headers: { 'X-Logbird-Export-Id': id } });
  vi.spyOn(response, 'blob').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:qa-export');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  const button = await start();
  await settle(1100);
  expect(document.body.textContent).toContain('Downloading export 9cfb85bf');
  expect(document.body.textContent).not.toContain('waiting for');
  act(() => finish(new Blob(['id,timestamp\n'])));
  await settle();
  expect(button.disabled).toBe(false);
  expect(revoke).toHaveBeenCalledWith('blob:qa-export');
  expect(click).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain('Spreadsheet (CSV) ready');
});
