import type { AuditEvent } from '@logbird/contracts';
import { eventSentence, personLabel } from '@/lib/events';
import { formatTimestamp } from '@/lib/format';

/**
 * The row's accessible name: what happened (actor, action, target), how it ended and when. Screen readers announce
 * it when the roving focus lands on the row, so it must stand on its own without the visual columns.
 */
export function eventRowLabel(e: AuditEvent, now = Date.now()): string {
  const sentence = eventSentence(e);
  const actor = personLabel(e.actor);
  const parts = [sentence];
  // Producer descriptions do not always name who acted ("Booking cancelled"): add the actor when it is missing.
  if (actor && !sentence.toLowerCase().includes(actor.toLowerCase())) parts.push(`by ${actor}`);
  if (e.impersonator) parts.push(`while ${e.impersonator.name || e.impersonator.id} was impersonating`);
  parts.push(e.outcome);
  if (sentence !== e.action) parts.push(e.action);
  parts.push(formatTimestamp(e.timestamp, now));
  return parts.join(', ');
}

/**
 * Where a grid key moves the roving focus, or null when the key is not a navigation key. `page` is the number of rows
 * one PageUp/PageDown jumps (about one viewport).
 */
export function nextRowIndex(key: string, current: number, count: number, page: number): number | null {
  if (count <= 0) return null;
  const clamp = (i: number) => Math.min(count - 1, Math.max(0, i));
  switch (key) {
    case 'ArrowDown':
      return clamp(current + 1);
    case 'ArrowUp':
      return clamp(current - 1);
    case 'PageDown':
      return clamp(current + Math.max(1, page));
    case 'PageUp':
      return clamp(current - Math.max(1, page));
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Where the grid's cursor (its roving tab stop) is in `rows`. The cursor is an event id, so it follows its event when
 * live tail prepends rows or a refetch reorders them. When that event is gone (a filter removed it), the cursor falls
 * back to the row now at the last index it had, clamped to the list: `fallback` is then true and the caller decides —
 * the events table keeps that place only while the grid has focus, and otherwise starts over at the top (a new result
 * set). -1 when there are no rows.
 */
export function resolveCursor(
  rows: readonly { id: string }[],
  cursorId: string | null | undefined,
  lastIndex: number,
): { index: number; fallback: boolean } {
  if (rows.length === 0) return { index: -1, fallback: false };
  if (cursorId) {
    const index = rows.findIndex((r) => r.id === cursorId);
    if (index >= 0) return { index, fallback: false };
  }
  return { index: Math.min(Math.max(lastIndex, 0), rows.length - 1), fallback: Boolean(cursorId) };
}

/**
 * How many rows were prepended above what used to be the first row (a live-tail batch): its new index. 0 when nothing
 * was prepended or the list was replaced (the old first row is gone).
 */
export function prependedCount(previousFirstId: string | undefined, rows: readonly { id: string }[]): number {
  if (!previousFirstId || rows[0]?.id === previousFirstId) return 0;
  return Math.max(
    0,
    rows.findIndex((r) => r.id === previousFirstId),
  );
}
