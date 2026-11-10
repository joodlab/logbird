import { AmbiguousInsertError, type EventRow, INSERT_LEASE_BUDGET_MS, isPrewriteParseError } from '@logbird/clickhouse';

// At most 64 extra statements after the original rejection, including healthy halves.
export const MAX_PARSE_ISOLATION_STATEMENTS = 64;
export const STORAGE_PARSE_REJECTION = 'invalid_event: Storage could not parse this event. Check event field types, Unicode and timestamps.';
// Proved unwritten, but not isolated before the statement or lease budget ran out.
export const STORAGE_PARSE_UNRESOLVED =
  'invalid_event: Storage could not parse this batch and isolation stopped before this event was checked. Resend it in a smaller batch.';

/** Only a proved pre-write rejection permits splitting. Every child keeps the original lease. */
export async function isolateIngestRows(
  rows: EventRow[],
  leaseExpiresAt: number,
  insert: (rows: EventRow[], leaseExpiresAt: number) => Promise<void>,
  settledIds: ReadonlySet<string> = new Set(),
) {
  const written: EventRow[] = [],
    rejected: EventRow[] = [],
    pending: EventRow[] = [],
    unavailable: EventRow[] = [],
    unresolved: EventRow[] = [];
  let extraStatements = 0;
  let limited = false;
  async function visit(part: EventRow[], provedPrewrite = false): Promise<void> {
    const fresh = part.filter((row) => !settledIds.has(row.event_id));
    if (provedPrewrite) {
      if (extraStatements >= MAX_PARSE_ISOLATION_STATEMENTS || Date.now() + INSERT_LEASE_BUDGET_MS > leaseExpiresAt) {
        // The parent proved these unsent rows absent. Keep the old parse rejection fallback.
        if (fresh.length) limited = true;
        unresolved.push(...fresh);
        return;
      }
      extraStatements++;
    }
    if (!fresh.length) return;
    try {
      await insert(fresh, leaseExpiresAt);
      written.push(...fresh);
    } catch (error) {
      if (error instanceof AmbiguousInsertError) pending.push(...fresh);
      else if (isPrewriteParseError(error)) {
        if (part.length === 1) rejected.push(...fresh);
        else {
          const middle = Math.floor(part.length / 2);
          await visit(part.slice(0, middle), true);
          await visit(part.slice(middle), true);
        }
      } else if (provedPrewrite && Date.now() + INSERT_LEASE_BUDGET_MS > leaseExpiresAt) {
        // Socket acquisition can consume the remaining lease before a child body is sent.
        limited = true;
        unresolved.push(...fresh);
      } else unavailable.push(...fresh);
    }
  }
  if (rows.length) await visit(rows);
  return { written, rejected, pending, unavailable, unresolved, limited };
}
