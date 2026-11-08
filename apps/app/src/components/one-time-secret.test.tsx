// @vitest-environment happy-dom
import { CopyButton } from '@logbird/ui/components/copy-button';
import { Button } from '@logbird/ui/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@logbird/ui/components/ui/dialog';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CloseWithoutCopying, useSecretCloseGuard } from './one-time-secret';
import { PendingHint } from './pending-hint';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function render(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
}

function SecretDialog() {
  const [open, setOpen] = useState(true);
  const guard = useSecretCloseGuard(true);
  return (
    <>
      <output data-testid="dialog-state">{open ? 'open' : 'closed'}</output>
      <Dialog onOpenChange={(next, details) => guard.guard(next, details) && setOpen(next)} open={open}>
        <DialogContent>
          <DialogTitle>Key created</DialogTitle>
          <code data-testid="one-time-secret">lb_ingest_fictional</code>
          <CopyButton label="Copy key" onCopied={guard.markCopied} showLabel value="lb_ingest_fictional" />
          {guard.confirming ? (
            <CloseWithoutCopying onClose={() => setOpen(false)} onKeep={guard.cancelConfirm} />
          ) : (
            <Button onClick={() => setOpen(false)}>I have stored the key</Button>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
const dialogState = () => document.querySelector('[data-testid="dialog-state"]')?.textContent;

const pressEscape = async () => {
  await act(async () => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
};
const secretVisible = () => Boolean(document.querySelector('[data-testid="one-time-secret"]'));

it('OWNER-10: Escape never discards an uncopied secret, it asks first', async () => {
  render(<SecretDialog />);
  expect(secretVisible()).toBe(true);
  await pressEscape();
  expect(dialogState()).toBe('open');
  expect(secretVisible()).toBe(true);
  expect(document.querySelector('[data-testid="secret-close-confirm"]')?.textContent).toContain('Close without copying?');
  // "Keep it open" has focus: a second stray Escape still keeps the secret.
  await pressEscape();
  expect(dialogState()).toBe('open');
  expect(secretVisible()).toBe(true);
});

it('OWNER-10: once copied, Escape closes normally', async () => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
  render(<SecretDialog />);
  const copy = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Copy key'));
  await act(async () => {
    copy?.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await pressEscape();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(document.querySelector('[data-testid="secret-close-confirm"]')).toBeNull();
  expect(dialogState()).toBe('closed');
});

it('OWNER-08: slow actions explain themselves after a second, fast ones never flash text', () => {
  vi.useFakeTimers();
  render(<PendingHint pending slow="Deleting QA Fix project…" slower="You can leave this page." />);
  expect(document.querySelector('[data-testid="pending-hint"]')).toBeNull();
  act(() => vi.advanceTimersByTime(1000));
  expect(document.querySelector('[data-testid="pending-hint"]')?.textContent).toBe('Deleting QA Fix project…');
  act(() => vi.advanceTimersByTime(5000));
  expect(document.querySelector('[data-testid="pending-hint"]')?.textContent).toBe('Deleting QA Fix project… You can leave this page.');
  act(() => root?.render(<PendingHint pending={false} slow="Deleting QA Fix project…" />));
  expect(document.querySelector('[data-testid="pending-hint"]')).toBeNull();
});
