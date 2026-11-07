// @vitest-environment happy-dom
import type { AuditEvent } from '@logbird/contracts';
import { Sheet, SheetContent, SheetTitle } from '@logbird/ui/components/ui/sheet';
import { act, createRef, useImperativeHandle, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventsTable, type EventsTableHandle } from './events-table';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A desktop viewport the virtualizer can measure: happy-dom does no layout, so every box reports this size. */
const VIEW = { width: 1440, height: 360 };
const ROW = 36;

beforeAll(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEW.width });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => VIEW.height });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => VIEW.width });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => VIEW.height });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => VIEW.width });
});

function event(id: string, i: number): AuditEvent {
  return {
    id,
    timestamp: new Date(Date.UTC(2026, 10, 5, 10, 0, 0) - i * 1000).toISOString(),
    receivedAt: new Date(Date.UTC(2026, 10, 5, 10, 0, 0) - i * 1000).toISOString(),
    environment: 'production',
    action: 'booking.cancelled',
    category: 'booking',
    outcome: 'success',
    severity: 'info',
    description: `Booking ${id} cancelled`,
    actor: { type: 'user', id: 'usr_vera', name: 'Vera Validator', email: 'vera@example.test' },
    impersonator: null,
    executor: null,
    tenant: null,
    source: null,
    targets: [],
    changes: [],
    context: { operationId: '', parentEventId: '', requestId: '', traceId: '', ip: '', userAgent: '' },
    attributes: {},
    conformance: 0,
    schemaVersion: '1',
    sdk: '',
  } as unknown as AuditEvent;
}
const page = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => event(`${prefix}${i}`, i));

interface HarnessHandle {
  setRows: (update: (rows: AuditEvent[]) => AuditEvent[]) => void;
  setSelected: (id: string | undefined) => void;
  /** Commit a new result set and its key together, as Explorer and Workspace Activity do. */
  setResult: (rows: AuditEvent[], key: string) => void;
}

interface HarnessOptions {
  onCursorChange?: (id: string | null) => void;
  loadMore?: () => void;
  /** Mount an event sheet whose final focus is composed as in Explorer and Workspace Activity. */
  sheet?: boolean;
  /** Pass a `resultKey` (starting with this one), as both pages do. */
  resultKey?: string;
}

/**
 * Mounts the table like a consumer: Explorer controls the cursor (`controlled`), Workspace Activity does not. Around it,
 * a query field (the focus fallback, as on both pages) and another control.
 */
function Harness({
  initial,
  controlled,
  table,
  harness,
  options,
}: {
  initial: AuditEvent[];
  controlled: boolean;
  table: React.RefObject<EventsTableHandle | null>;
  harness: React.Ref<HarnessHandle>;
  options: HarnessOptions;
}) {
  const [rows, setRows] = useState(initial);
  const [selected, setSelected] = useState<string | undefined>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [resultKey, setResultKey] = useState(options.resultKey);
  const query = useRef<HTMLInputElement>(null);
  useImperativeHandle(
    harness,
    () => ({
      setRows,
      setSelected,
      setResult: (next, key) => {
        setRows(next);
        setResultKey(key);
      },
    }),
    [],
  );
  return (
    <>
      <input aria-label="Query" data-testid="query" ref={query} />
      <button data-testid="elsewhere" type="button">
        Elsewhere
      </button>
      <div style={{ display: 'flex', height: VIEW.height }}>
        <EventsTable
          columns={['time', 'outcome', 'action', 'description', 'actor']}
          focusFallback={() => query.current}
          hasMore={Boolean(options.loadMore)}
          loadMore={options.loadMore}
          onSelect={(e) => setSelected(e.id)}
          ref={table}
          resultKey={resultKey}
          rows={rows}
          selectedId={selected}
          {...(controlled
            ? {
                cursorId: cursor,
                onCursorChange: (id: string | null) => {
                  setCursor(id);
                  options.onCursorChange?.(id);
                },
              }
            : { onCursorChange: options.onCursorChange })}
        />
      </div>
      {options.sheet ? (
        <Sheet onOpenChange={(open) => !open && setSelected(undefined)} open={Boolean(selected)}>
          <SheetContent finalFocus={() => table.current?.cursorElement() ?? query.current ?? true}>
            <SheetTitle>Event {selected}</SheetTitle>
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  );
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(rows: AuditEvent[], controlled: boolean, options: HarnessOptions | ((id: string | null) => void) = {}) {
  const opts = typeof options === 'function' ? { onCursorChange: options } : options;
  const table = createRef<EventsTableHandle>();
  const harness = createRef<HarnessHandle>();
  act(() => root.render(<Harness controlled={controlled} harness={harness} initial={rows} options={opts} table={table} />));
  // Let the virtualizer measure the viewport and render its range.
  flush();
  return { table: () => table.current as EventsTableHandle, harness: () => harness.current as HarnessHandle };
}

/** Let the virtualizer's measurement and focus effects settle. */
const flush = () => act(() => undefined);
/** Let the dialog's open/close (Base UI waits for its transitions) finish. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

const scroller = () => host.querySelector<HTMLElement>('.overflow-auto') as HTMLElement;
const rowOf = (id: string) => host.querySelector<HTMLElement>(`[role="row"][data-event-id="${id}"]`);
const focusedId = () => (document.activeElement as HTMLElement | null)?.dataset.eventId;
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`) as HTMLElement;
const tabStops = () => [...host.querySelectorAll<HTMLElement>('[role="row"][tabindex="0"]')].map((r) => r.dataset.eventId);
const keydown = (target: Element, k: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
function key(target: Element, k: string, init: KeyboardEventInit = {}) {
  act(() => {
    keydown(target, k, init);
  });
}
function scrollTo(top: number) {
  act(() => {
    scroller().scrollTop = top;
    scroller().dispatchEvent(new Event('scroll'));
  });
}

describe.each([
  ['controlled (Explorer)', true],
  ['uncontrolled (Workspace Activity)', false],
])('EventsTable roving cursor, %s', (_, controlled) => {
  it('moves the tab stop with the arrow keys and keeps the focused row mounted when scrolled away', () => {
    const onCursorChange = vi.fn();
    const t = mount(page('e', 500), controlled, onCursorChange);
    expect(tabStops()).toEqual(['e0']);
    act(() => {
      rowOf('e0')?.focus();
    });
    key(rowOf('e0') as Element, 'ArrowDown');
    key(rowOf('e1') as Element, 'ArrowDown');
    expect(focusedId()).toBe('e2');
    expect(tabStops()).toEqual(['e2']);
    expect(onCursorChange).toHaveBeenLastCalledWith('e2');

    // Scroll far past the overscan: the focused row stays rendered (and focused), so Tab back returns to it.
    scrollTo(300 * ROW);
    expect(rowOf('e300')).not.toBeNull();
    expect(rowOf('e3')).toBeNull(); // ordinary rows far above the viewport are virtualized away…
    expect(rowOf('e2')).not.toBeNull(); // …the focused one is not
    expect(focusedId()).toBe('e2');
    expect(t.table().cursorElement()?.dataset.eventId).toBe('e2');
  });

  it('follows the open event, so a dialog returns focus to the last row it showed', () => {
    const t = mount(page('e', 200), controlled);
    act(() => t.harness().setSelected('e7'));
    act(() => t.harness().setSelected('e8')); // next in the sheet
    expect(t.table().cursorElement()?.dataset.eventId).toBe('e8');
    expect(tabStops()).toEqual(['e8']);
  });

  it('returns focus to a real row when the open event is not in the loaded rows (a deep link)', () => {
    const t = mount(page('e', 200), controlled);
    act(() => t.harness().setSelected('elsewhere'));
    expect(t.table().cursorElement()?.dataset.eventId).toBe('e0');
    expect(tabStops()).toEqual(['e0']);
  });

  it('keeps focus on the same event when live tail prepends more rows than the overscan, without moving the view', () => {
    const t = mount(page('e', 10_000), controlled);
    act(() => {
      t.table().focusRow(50);
    });
    expect(focusedId()).toBe('e50');
    const node = rowOf('e50');
    const before = scroller().scrollTop;

    act(() => t.harness().setRows((rows) => [...page('live', 100), ...rows]));
    flush();

    // Same event, same DOM node, still focused, now at index 150 — and still the tab stop.
    expect(focusedId()).toBe('e50');
    expect(rowOf('e50')).toBe(node);
    expect(rowOf('e50')?.dataset.index).toBe('150');
    expect(tabStops()).toEqual(['e50']);
    // The view moved down by exactly the prepended rows: what was on screen stays on screen.
    expect(scroller().scrollTop).toBe(before + 100 * ROW);
    // j/k-style moves continue from the focused event, not from its old index.
    key(rowOf('e50') as Element, 'ArrowDown');
    expect(focusedId()).toBe('e51');
  });

  it('moves focus to the row now in its place when a filter removes the focused event', () => {
    const onCursorChange = vi.fn();
    const t = mount(page('e', 300), controlled, onCursorChange);
    act(() => {
      t.table().focusRow(20);
    });
    expect(focusedId()).toBe('e20');

    act(() => t.harness().setRows((rows) => rows.filter((e) => e.id !== 'e20')));
    flush();

    expect(focusedId()).toBe('e21');
    expect(tabStops()).toEqual(['e21']);
    expect(onCursorChange).toHaveBeenLastCalledWith('e21');
    expect(t.table().cursorElement()?.dataset.eventId).toBe('e21');
  });

  it('drops a pending far-jump focus whose event leaves the list before its row mounts', () => {
    const t = mount(page('e', 2000), controlled);
    act(() => {
      rowOf('e0')?.focus();
    });
    // End, and in the same pass (before the virtualizer has mounted row 1999) a refetch removes that event: the focus
    // request is still pending when its target disappears.
    act(() => {
      keydown(rowOf('e0') as Element, 'End');
      expect(rowOf('e1999')).toBeNull();
      t.harness().setRows((rows) => rows.slice(0, 1999));
    });
    flush();
    // Not moved to the row that took its index: focus stays where it was.
    expect(focusedId()).toBe('e0');
    // The event comes back and scrolls into view: the dropped request must not fire late and steal focus.
    act(() => t.harness().setRows(() => page('e', 2000)));
    scrollTo(1990 * ROW);
    flush();
    expect(rowOf('e1999')).not.toBeNull();
    expect(focusedId()).toBe('e0');
  });

  it('accepts Ctrl+Home and Ctrl+End (the APG grid keys) as well as Home and End', () => {
    mount(page('e', 300), controlled);
    act(() => {
      rowOf('e0')?.focus();
    });
    key(rowOf('e0') as Element, 'End', { ctrlKey: true });
    flush();
    expect(focusedId()).toBe('e299');
    key(rowOf('e299') as Element, 'Home', { ctrlKey: true });
    flush();
    expect(focusedId()).toBe('e0');
    // Other Ctrl chords stay the browser's.
    key(rowOf('e0') as Element, 'ArrowDown', { ctrlKey: true });
    expect(focusedId()).toBe('e0');
  });

  it('does not scroll or load more when a new result set replaces the list while focus is elsewhere', () => {
    const loadMore = vi.fn();
    const onCursorChange = vi.fn();
    const t = mount(page('e', 500), controlled, { loadMore, onCursorChange });
    // The reader opened event 300 earlier, went back to the top with the mouse, and then clicked a facet.
    act(() => {
      t.table().focusRow(300);
    });
    flush();
    expect(focusedId()).toBe('e300');
    act(() => byTestId('elsewhere').focus());
    scrollTo(0);
    flush();
    loadMore.mockClear();

    act(() => t.harness().setRows(() => page('n', 100)));
    flush();

    expect(scroller().scrollTop).toBe(0);
    expect(loadMore).not.toHaveBeenCalled();
    expect(tabStops()).toEqual(['n0']);
    expect(onCursorChange).toHaveBeenLastCalledWith(null);
    expect(document.activeElement).toBe(byTestId('elsewhere'));
    // Tabbing back in lands on the first row of the new results, and the arrows start from there.
    act(() => {
      t.table().focusCursor();
    });
    expect(focusedId()).toBe('n0');
    key(rowOf('n0') as Element, 'ArrowDown');
    expect(focusedId()).toBe('n1');
  });

  it('starts a new result set at the top when the grid has focus and the cursor event is not in it ("Filter by…")', () => {
    const loadMore = vi.fn();
    const onCursorChange = vi.fn();
    const t = mount(page('e', 500), controlled, { loadMore, onCursorChange });
    // The sheet closed onto event 300 and returned focus to its row before the filtered results arrived.
    act(() => {
      t.table().focusRow(300);
    });
    scrollTo(295 * ROW);
    flush();
    expect(focusedId()).toBe('e300');
    loadMore.mockClear();

    // Neither the old first row nor event 300 is in the new page.
    act(() => t.harness().setRows(() => page('n', 100)));
    flush();

    expect(focusedId()).toBe('n0');
    expect(tabStops()).toEqual(['n0']);
    expect(scroller().scrollTop).toBe(0);
    expect(onCursorChange).toHaveBeenLastCalledWith('n0');
    // No second page from the old scroll position (the virtualizer has not seen a scroll event yet) — nor once the
    // browser's scroll event has caught up.
    expect(loadMore).not.toHaveBeenCalled();
    scrollTo(0);
    flush();
    expect(loadMore).not.toHaveBeenCalled();
    key(rowOf('n0') as Element, 'ArrowDown');
    expect(focusedId()).toBe('n1');
  });

  it('keeps focus on its event and scrolls it into view when a new result set still holds it at another index', () => {
    const loadMore = vi.fn();
    const t = mount(page('e', 500), controlled, { loadMore });
    act(() => {
      t.table().focusRow(300);
    });
    scrollTo(295 * ROW);
    flush();
    const kept = page('e', 500)[300] as AuditEvent;
    loadMore.mockClear();
    // happy-dom does no layout (scrollHeight 0), and the virtualizer clamps scrolls to it: give the new list its height.
    Object.defineProperty(scroller(), 'scrollHeight', { configurable: true, get: () => 32 + 100 * ROW + 48 });

    act(() => t.harness().setRows(() => [...page('n', 10), kept, ...page('m', 89)]));
    flush();
    scrollTo(scroller().scrollTop);
    flush();

    expect(focusedId()).toBe('e300');
    expect(tabStops()).toEqual(['e300']);
    // Row 10 is inside the viewport (below the 32px column header).
    const top = scroller().scrollTop;
    expect(10 * ROW).toBeGreaterThanOrEqual(top);
    expect(11 * ROW + 32).toBeLessThanOrEqual(top + VIEW.height);
    expect(loadMore).not.toHaveBeenCalled();
  });

  it('starts a new result set at the top when its key changes, though its newest event is the old first row ("Filter by" a common value)', () => {
    const loadMore = vi.fn();
    const onCursorChange = vi.fn();
    const t = mount(page('e', 500), controlled, { loadMore, onCursorChange, resultKey: 'all' });
    // The sheet closed onto event 300 and returned focus to its row before the filtered results arrived.
    act(() => {
      t.table().focusRow(300);
    });
    scrollTo(295 * ROW);
    flush();
    expect(focusedId()).toBe('e300');
    loadMore.mockClear();

    // The newest event matches the filter too, so the old first row is row 0 again; event 300 is not on page 1.
    const [e0] = page('e', 1) as [AuditEvent];
    act(() => t.harness().setResult([e0, ...page('n', 100).slice(1)], 'outcome:success'));
    flush();

    expect(focusedId()).toBe('e0');
    expect(tabStops()).toEqual(['e0']);
    expect(scroller().scrollTop).toBe(0);
    expect(onCursorChange).toHaveBeenLastCalledWith('e0');
    expect(loadMore).not.toHaveBeenCalled();
    scrollTo(0);
    flush();
    expect(loadMore).not.toHaveBeenCalled();
    key(rowOf('e0') as Element, 'ArrowDown');
    expect(focusedId()).toBe('n1');
  });

  it('treats a changed list under the same key as the same list: a focused grid keeps its place when its event leaves', () => {
    const t = mount(page('e', 300), controlled, { resultKey: 'all' });
    act(() => {
      t.table().focusRow(20);
    });
    // Same key, and the old first row is gone too: still the same list, so the row now at its index (20) takes focus.
    act(() => t.harness().setRows((rows) => rows.filter((e) => e.id !== 'e0' && e.id !== 'e20')));
    flush();
    expect(focusedId()).toBe('e22');
  });

  it.each([
    ['without a result key', undefined],
    ['with a result key', 'all'],
  ])('does not scroll to the cursor event at its new index while focus is elsewhere (%s)', (_, resultKey) => {
    const loadMore = vi.fn();
    const t = mount(page('e', 500), controlled, { loadMore, resultKey });
    // Opened row 3 earlier, then went back to the query: the cursor stays on that event.
    act(() => {
      t.table().focusRow(3);
    });
    act(() => byTestId('elsewhere').focus());
    flush();
    expect(scroller().scrollTop).toBe(0);
    loadMore.mockClear();
    // happy-dom does no layout (scrollHeight 0), and the virtualizer clamps scrolls to it: give the new list its height.
    Object.defineProperty(scroller(), 'scrollHeight', { configurable: true, get: () => 32 + 100 * ROW + 48 });

    // A broader query: the event is now row 60.
    const kept = page('e', 4)[3] as AuditEvent;
    const next = [...page('n', 60), kept, ...page('m', 39)];
    act(() => (resultKey ? t.harness().setResult(next, 'broader') : t.harness().setRows(() => next)));
    flush();
    scrollTo(scroller().scrollTop);
    flush();

    expect(scroller().scrollTop).toBe(0);
    expect(loadMore).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(byTestId('elsewhere'));
    // Still the tab stop, mounted off-screen: Tab back in brings it into view.
    expect(tabStops()).toEqual(['e3']);
    expect(rowOf('e3')?.dataset.index).toBe('60');
  });

  it('returns a new result set to the top while focus is elsewhere, even when it still holds the cursor event', () => {
    const loadMore = vi.fn();
    const t = mount(page('e', 500), controlled, { loadMore, resultKey: 'all' });
    act(() => {
      t.table().focusRow(300);
    });
    act(() => byTestId('elsewhere').focus());
    scrollTo(280 * ROW);
    flush();
    loadMore.mockClear();
    Object.defineProperty(scroller(), 'scrollHeight', { configurable: true, get: () => 32 + 100 * ROW + 48 });

    const kept = page('e', 301)[300] as AuditEvent;
    act(() => t.harness().setResult([...page('n', 60), kept, ...page('m', 39)], 'filtered'));
    flush();
    // The browser's scroll event catches up with the reset.
    scrollTo(scroller().scrollTop);
    flush();

    expect(scroller().scrollTop).toBe(0);
    expect(loadMore).not.toHaveBeenCalled();
    expect(tabStops()).toEqual(['e300']);
    expect(document.activeElement).toBe(byTestId('elsewhere'));
  });

  it.each([
    ['focus elsewhere', false],
    ['focus on the row', true],
  ])('keeps the paged rows still once live tail is capped and drops rows above them (%s)', (_, focused) => {
    // 2000 live rows (the cap) above the paged results; the cursor is on a paged event, and the view shows it.
    const live = page('l', 2000);
    const paged = page('e', 500);
    const t = mount([...live, ...paged], controlled);
    Object.defineProperty(scroller(), 'scrollHeight', { configurable: true, get: () => 32 + 2600 * ROW + 48 });
    act(() => {
      t.table().focusRow(2010);
    });
    flush();
    expect(focusedId()).toBe('e10');
    if (!focused) act(() => byTestId('elsewhere').focus());
    scrollTo(2005 * ROW);
    flush();
    const before = scroller().scrollTop;

    // A batch of 5 arrives and the capped tail drops its oldest 5: e10 (and every paged row) keeps its index.
    act(() => t.harness().setRows(() => [...page('x', 5), ...live.slice(0, 1995), ...paged]));
    flush();
    scrollTo(scroller().scrollTop);
    flush();
    // The next poll does the same.
    act(() => t.harness().setRows((rows) => [...page('y', 5), ...rows.slice(0, 1995), ...paged]));
    flush();
    scrollTo(scroller().scrollTop);
    flush();

    expect(rowOf('e10')?.dataset.index).toBe('2010');
    expect(tabStops()).toEqual(['e10']);
    // Nothing on screen moved, so neither does the view: not 5 rows further per poll, and no scroll to the cursor.
    expect(scroller().scrollTop).toBe(before);
    expect(document.activeElement).toBe(focused ? rowOf('e10') : byTestId('elsewhere'));
  });

  it('still follows the live rows on screen down by the batch size once the tail is capped', () => {
    const live = page('l', 2000);
    const paged = page('e', 500);
    const t = mount([...live, ...paged], controlled);
    act(() => byTestId('elsewhere').focus());
    scrollTo(1500 * ROW);
    flush();
    const before = scroller().scrollTop;
    act(() => t.harness().setRows(() => [...page('x', 5), ...live.slice(0, 1995), ...paged]));
    flush();
    expect(scroller().scrollTop).toBe(before + 5 * ROW);
  });

  it('hands focus to the query field when a refetch empties the list under a focused row', () => {
    const t = mount(page('e', 50), controlled);
    act(() => {
      t.table().focusRow(5);
    });
    expect(focusedId()).toBe('e5');
    act(() => t.harness().setRows(() => []));
    flush();
    expect(host.querySelector('[role="grid"]')).toBeNull();
    expect(document.activeElement).toBe(byTestId('query'));
    expect(t.table().cursorElement()).toBeNull();
  });

  it('leaves focus alone when the list empties while another control has it', () => {
    const t = mount(page('e', 50), controlled);
    act(() => byTestId('elsewhere').focus());
    act(() => t.harness().setRows(() => []));
    flush();
    expect(document.activeElement).toBe(byTestId('elsewhere'));
  });

  it('returns focus from the sheet to its row, or to the query field when the list emptied meanwhile', async () => {
    const t = mount(page('e', 50), controlled, { sheet: true });
    act(() => {
      t.table().focusRow(4);
    });
    key(rowOf('e4') as Element, 'Enter');
    await settle();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    key(document.activeElement as Element, 'Escape');
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(focusedId()).toBe('e4');

    // Open it again; behind the modal sheet a refetch empties the list before it closes.
    key(rowOf('e4') as Element, 'Enter');
    await settle();
    act(() => t.harness().setRows(() => []));
    key(document.activeElement as Element, 'Escape');
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(byTestId('query'));
  });
});

describe('EventsTable live tail at the top', () => {
  it('lets new rows push in when the reader is at the top and focus is elsewhere', () => {
    const t = mount(page('e', 200), false);
    expect(scroller().scrollTop).toBe(0);
    act(() => t.harness().setRows((rows) => [...page('live', 5), ...rows]));
    expect(scroller().scrollTop).toBe(0);
    expect(rowOf('live0')).not.toBeNull();
  });
});

describe('EventsTable on a phone', () => {
  beforeAll(() => Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 }));
  afterAll(() => Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEW.width }));

  it('renders one real gridcell per 64px row (not display: contents) and keeps the grid keys', () => {
    mount(page('e', 100), false);
    const row = rowOf('e0') as HTMLElement;
    expect(host.querySelector('[role="columnheader"]')).toBeNull();
    expect(host.querySelector('[role="grid"]')?.getAttribute('aria-colcount')).toBe('1');
    const cells = row.querySelectorAll<HTMLElement>('[role="gridcell"]');
    expect(cells).toHaveLength(1);
    expect(cells[0]?.classList.contains('contents')).toBe(false);
    expect(cells[0]?.classList.contains('flex')).toBe(true);
    expect(row.style.height).toBe('64px');
    expect(row.getAttribute('aria-rowindex')).toBe('1');
    expect(row.hasAttribute('aria-selected')).toBe(false);
    act(() => row.focus());
    key(row, 'ArrowDown');
    expect(focusedId()).toBe('e1');
  });
});
