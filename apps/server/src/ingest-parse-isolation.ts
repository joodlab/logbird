import { AmbiguousInsertError, type EventRow, INSERT_LEASE_BUDGET_MS, InsertLeaseExhaustedError, isPrewriteParseError } from '@logbird/clickhouse';

// Extra statements after the original failure; exact row reports need k+1 total for k bad rows.
export const MAX_PARSE_ISOLATION_STATEMENTS = 64;
export const MAX_PARSE_ISOLATION_MS = 10_000;
export const STORAGE_PARSE_REJECTION = 'invalid_event: Storage could not parse this event. Check event field types, Unicode and timestamps.';

/** Every insert closes over the original lease; only proven-unwritten partitions may be split. */
export async function isolateIngestRows(rows: EventRow[], leaseExpiresAt: number, insert: (rows: EventRow[]) => Promise<void>) {
  const written: EventRow[] = [],
    rejected: EventRow[] = [],
    pending: EventRow[] = [],
    unavailable: EventRow[] = [],
    unresolved: EventRow[] = [];
  let statements = 0;
  let isolationDeadline = Number.POSITIVE_INFINITY;
  let limited = false;
  function defer(part: EventRow[]) {
    limited = true;
    unresolved.push(...part);
  }
  async function parseFailure(part: EventRow[], error?: unknown): Promise<void> {
    if (part.length === 1) {
      rejected.push(...part);
      return;
    }
    const match = error instanceof Error ? /\(at row (\d+)\)/i.exec(error.message) : null;
    const index = match ? Number(match[1]) - 1 : -1;
    if (Number.isSafeInteger(index) && index >= 0 && index < part.length) {
      rejected.push(part[index] as EventRow);
      await visit(part.filter((_, i) => i !== index));
      return;
    }
    const middle = Math.floor(part.length / 2);
    const leftWritten = await visit(part.slice(0, middle));
    const right = part.slice(middle);
    // The failed parent contains a bad row. A written left proves the right contains it:
    // split the right directly instead of resending a body already known to fail.
    if (leftWritten) await parseFailure(right);
    else await visit(right);
  }
  async function visit(part: EventRow[]): Promise<boolean> {
    if (!part.length) return true;
    if (statements > MAX_PARSE_ISOLATION_STATEMENTS || Date.now() >= isolationDeadline || Date.now() + INSERT_LEASE_BUDGET_MS > leaseExpiresAt) {
      defer(part);
      return false;
    }
    statements++;
    try {
      await insert(part);
      written.push(...part);
      return true;
    } catch (error) {
      if (error instanceof AmbiguousInsertError) pending.push(...part);
      else if (error instanceof InsertLeaseExhaustedError) defer(part);
      else if (isPrewriteParseError(error)) {
        isolationDeadline = Math.min(isolationDeadline, Date.now() + MAX_PARSE_ISOLATION_MS);
        await parseFailure(part, error);
      } else unavailable.push(...part);
      return false;
    }
  }
  await visit(rows);
  return { written, rejected, pending, unavailable, unresolved, limited };
}
