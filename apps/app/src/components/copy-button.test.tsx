// @vitest-environment happy-dom
import { CopyButton } from '@logbird/ui/components/copy-button';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.unstubAllGlobals());

async function click(onCopied: () => void) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<CopyButton label="Copy secret" onCopied={onCopied} showLabel value="whsec_fixture" />));
  await act(async () => {
    host.querySelector('button')?.click();
    await new Promise((r) => setTimeout(r, 10));
  });
  const text = host.querySelector('button')?.getAttribute('aria-label');
  act(() => root.unmount());
  host.remove();
  return text;
}

describe('a once-only secret is copied only when the copy happened', () => {
  it('reports a copy when the clipboard takes it', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => undefined) } });
    const onCopied = vi.fn();
    expect(await click(onCopied)).toBe('Copied');
    expect(onCopied).toHaveBeenCalledOnce();
  });
  it('does not report a copy when the clipboard and its fallback both fail', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('blocked'))) } });
    document.execCommand = vi.fn(() => false);
    const onCopied = vi.fn();
    expect(await click(onCopied)).toBe('Copy secret');
    expect(onCopied).not.toHaveBeenCalled();
  });
});
