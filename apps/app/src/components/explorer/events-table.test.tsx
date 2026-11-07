// @vitest-environment happy-dom
import type { AuditEvent } from '@logbird/contracts';
import { act, createRef, useImperativeHandle, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
}

/** Mounts the table like a consumer: Explorer controls the cursor (`controlled`), Workspace Activity does not. */
function Harness({
  initial,
  controlled,
  table,
  harness,
  onCursorChange,
}: {
  initial: AuditEvent[];
  controlled: boolean;
  table: React.Ref<EventsTableHandle>;
  harness: React.Ref<HarnessHandle>;
  onCursorChange?: (id: string) => void;
}) {
  const [rows, setRows] = useState(initial);
  const [selected, setSelected] = useState<string | undefined>();
  const [cursor, setCursor] = useState<string | null>(null);
  useImperativeHandle(harness, () => ({ setRows, setSelected }), []);
  return (
    <div style={{ display: 'flex', height: VIEW.height }}>
      <EventsTable
        columns={['time', 'outcome', 'action', 'description', 'actor']}
        onSelect={(e) => setSelected(e.id)}
        ref={table}
        rows={rows}
        selectedId={selected}
        {...(controlled
          ? {
              cursorId: cursor,
              onCursorChange: (id: string) => {
                setCursor(id);
                onCursorChange?.(id);
              },
            }
          : { onCursorChange })}
      />
    </div>
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

function mount(rows: AuditEvent[], controlled: boolean, onCursorChange?: (id: string) => void) {
  const table = createRef<EventsTableHandle>();
  const harness = createRef<HarnessHandle>();
  act(() => root.render(<Harness controlled={controlled} harness={harness} initial={rows} onCursorChange={onCursorChange} table={table} />));
  // Let the virtualizer measure the viewport and render its range.
  flush();
  return { table: () => table.current as EventsTableHandle, harness: () => harness.current as HarnessHandle };
}

/** Let the virtualizer's measurement and focus effects settle. */
const flush = () => act(() => undefined);

const scroller = () => host.querySelector<HTMLElement>('.overflow-auto') as HTMLElement;
const rowOf = (id: string) => host.querySelector<HTMLElement>(`[role="row"][data-event-id="${id}"]`);
const focusedId = () => (document.activeElement as HTMLElement | null)?.dataset.eventId;
const tabStops = () => [...host.querySelectorAll<HTMLElement>('[role="row"][tabindex="0"]')].map((r) => r.dataset.eventId);
function key(target: Element, k: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
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

  it('drops a pending far-jump focus whose event left the list', () => {
    const t = mount(page('e', 2000), controlled);
    act(() => {
      rowOf('e0')?.focus();
    });
    // End: the target row is not rendered yet, so focus is pending until the virtualizer mounts it.
    key(rowOf('e0') as Element, 'End');
    flush();
    expect(focusedId()).toBe('e1999');
    // Remove that event: the grid keeps focus on a real row instead of a stale index.
    act(() => t.harness().setRows((rows) => rows.slice(0, 1999)));
    flush();
    expect(focusedId()).toBe('e1998');
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
