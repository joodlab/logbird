import type { AuditEvent } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import { eventRowLabel, nextRowIndex, prependedCount, resolveCursor } from './row-navigation';

function event(patch: Partial<AuditEvent>): AuditEvent {
  return {
    id: 'evt_1',
    timestamp: '2026-11-05T10:00:00.000Z',
    receivedAt: '2026-11-05T10:00:00.000Z',
    environment: 'production',
    action: 'booking.cancelled',
    category: 'booking',
    outcome: 'success',
    severity: 'info',
    description: '',
    actor: null,
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
    ...patch,
  } as AuditEvent;
}

const vera = { type: 'user', id: 'usr_vera', name: 'Vera Validator', email: 'vera@example.test' };
const now = Date.parse('2026-11-05T12:00:00.000Z');

describe('eventRowLabel', () => {
  it('summarises the sentence, outcome, action and time', () => {
    const label = eventRowLabel(event({ actor: vera, targets: [{ type: 'booking', id: 'bk_1', name: 'B-1042' }] as AuditEvent['targets'] }), now);
    expect(label.startsWith('Vera Validator ')).toBe(true);
    expect(label).toContain('B-1042');
    expect(label).toContain(', success, booking.cancelled, ');
  });

  it('names the actor when the producer description leaves them out', () => {
    const label = eventRowLabel(event({ actor: vera, description: 'Booking cancelled', outcome: 'failure' }), now);
    expect(label).toMatch(/^Booking cancelled, by Vera Validator, failure, booking\.cancelled, /);
  });

  it('mentions impersonation', () => {
    const label = eventRowLabel(
      event({ actor: vera, impersonator: { type: 'user', id: 'usr_sam', name: 'Sam Support' } as AuditEvent['impersonator'] }),
      now,
    );
    expect(label).toContain('while Sam Support was impersonating');
  });

  it('does not repeat the action when it is the whole sentence', () => {
    const label = eventRowLabel(event({}), now);
    expect(label.split('booking.cancelled')).toHaveLength(2);
  });
});

describe('nextRowIndex', () => {
  it('moves one row with the arrows and clamps at the ends', () => {
    expect(nextRowIndex('ArrowDown', 2, 10, 5)).toBe(3);
    expect(nextRowIndex('ArrowUp', 2, 10, 5)).toBe(1);
    expect(nextRowIndex('ArrowUp', 0, 10, 5)).toBe(0);
    expect(nextRowIndex('ArrowDown', 9, 10, 5)).toBe(9);
  });

  it('jumps a page and to the first and last loaded row', () => {
    expect(nextRowIndex('PageDown', 2, 10, 5)).toBe(7);
    expect(nextRowIndex('PageDown', 8, 10, 5)).toBe(9);
    expect(nextRowIndex('PageUp', 3, 10, 5)).toBe(0);
    expect(nextRowIndex('Home', 6, 10, 5)).toBe(0);
    expect(nextRowIndex('End', 1, 10, 5)).toBe(9);
  });

  it('ignores other keys and empty lists', () => {
    expect(nextRowIndex('a', 2, 10, 5)).toBeNull();
    expect(nextRowIndex('ArrowDown', 0, 0, 5)).toBeNull();
  });
});

describe('resolveCursor', () => {
  const rows = ['a', 'b', 'c', 'd'].map((id) => ({ id }));

  it('finds the cursor event wherever it moved', () => {
    expect(resolveCursor(rows, 'c', 0)).toEqual({ index: 2, fallback: false });
    // Live tail prepended two rows: same event, new index.
    expect(resolveCursor([{ id: 'x' }, { id: 'y' }, ...rows], 'c', 2)).toEqual({ index: 4, fallback: false });
  });

  it('uses the first row while there is no cursor', () => {
    expect(resolveCursor(rows, null, 0)).toEqual({ index: 0, fallback: false });
    expect(resolveCursor(rows, undefined, 3)).toEqual({ index: 3, fallback: false });
  });

  it('falls back to the row now at its last index when its event is gone, clamped to the list', () => {
    expect(resolveCursor(rows, 'gone', 1)).toEqual({ index: 1, fallback: true });
    expect(resolveCursor(rows, 'gone', 9)).toEqual({ index: 3, fallback: true });
  });

  it('has no tab stop without rows', () => {
    expect(resolveCursor([], 'a', 2)).toEqual({ index: -1, fallback: false });
  });
});

describe('prependedCount', () => {
  const rows = ['a', 'b', 'c'].map((id) => ({ id }));
  it('counts the rows a live batch put above the old first row', () => {
    expect(prependedCount('a', [{ id: 'n1' }, { id: 'n2' }, ...rows])).toBe(2);
  });
  it('is 0 when nothing was prepended, the list was replaced, or there was no list', () => {
    expect(prependedCount('a', rows)).toBe(0);
    expect(prependedCount('a', [...rows, { id: 'more' }])).toBe(0);
    expect(prependedCount('gone', rows)).toBe(0);
    expect(prependedCount(undefined, rows)).toBe(0);
  });
});
