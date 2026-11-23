// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextPurge } from './retention-status';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T11:59:00.000Z'));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host.remove();
  vi.useRealTimers();
});

const show = (at: string | null, running = false) =>
  act(() =>
    root?.render(
      <dl>
        <NextPurge at={at} running={running} />
      </dl>,
    ),
  );

it('a page left open turns a passed purge time into "Overdue" by itself, with no new status (#318)', () => {
  show('2026-11-23T12:00:00.000Z');
  expect(host.textContent).not.toContain('Overdue');
  // Seven minutes on, the same status: the card must not keep saying "in 1 min.".
  act(() => {
    vi.advanceTimersByTime(7 * 60_000);
  });
  expect(host.querySelector('[data-testid="purge-overdue"]')?.textContent).toContain('The retention worker may be delayed or stopped.');
  expect(host.textContent).toContain('Overdue');
});

it('a purge in progress is "Running now", never overdue, with no stale time beside it', () => {
  show('2026-11-23T01:25:00.000Z', true);
  expect(host.textContent).toContain('Running now');
  expect(host.textContent).not.toContain('Overdue');
  expect(host.textContent).toContain('The purge in progress, under Last purge.');
});

it('while a purge runs, the next one ahead says the run is in progress, and no schedule still says "Running now"', () => {
  show('2026-11-23T12:30:00.000Z', true);
  expect(host.querySelector('[data-testid="purge-running-next"]')?.textContent).toContain('After the purge in progress');
  show(null, true);
  expect(host.textContent).toContain('Running now');
  expect(host.textContent).not.toContain('Not scheduled');
  show(null, false);
  expect(host.textContent).toContain('Not scheduled');
});
