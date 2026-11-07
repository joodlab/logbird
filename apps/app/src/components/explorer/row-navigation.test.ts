import type { AuditEvent } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import { eventRowLabel, nextRowIndex } from './row-navigation';

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
