import { AmbiguousInsertError, type EventRow, INSERT_LEASE_BUDGET_MS, InsertLeaseExhaustedError, isPrewriteParseError } from '@logbird/clickhouse';

// Extra statements after the original failure, including the row-number canary and prefix writes.
export const MAX_PARSE_ISOLATION_STATEMENTS = 64;
export const MAX_PARSE_ISOLATION_MS = 10_000;
export const MAX_PARSE_ISOLATION_BYTE_MULTIPLIER = 4;
export const STORAGE_PARSE_REJECTION = 'invalid_event: Storage could not parse this event. Check event field types, Unicode and timestamps.';

/** Every insert closes over the original lease; only proven-unwritten partitions may be split. */
export async function isolateIngestRows(rows: EventRow[], leaseExpiresAt: number, insert: (rows: EventRow[], body: string) => Promise<void>) {
  const written: EventRow[] = [],
    rejected: EventRow[] = [],
    pending: EventRow[] = [],
    unavailable: EventRow[] = [],
    unresolved: EventRow[] = [];
  let statements = 0;
  let isolationDeadline = Number.POSITIVE_INFINITY;
  let limited = false;
  let limitReason: 'statements' | 'bytes' | 'wall_clock' | 'lease' | undefined;
  // Rows are immutable for this attempt. Cache JSON and UTF-8 lengths once, including each newline.
  const serialized = new Map(
    rows.map((row) => {
      const line = `${JSON.stringify(row)}\n`;
      return [row, { line, bytes: Buffer.byteLength(line) }] as const;
    }),
  );
  const bytes = (part: EventRow[]) => part.reduce((total, row) => total + serialized.get(row)!.bytes, 0);
  const isolationByteBudget = bytes(rows) * MAX_PARSE_ISOLATION_BYTE_MULTIPLIER;
  let isolationBytes = 0;
  let rowNumberChecked = false;
  let trustRowNumbers = true;
  function defer(part: EventRow[], reason: NonNullable<typeof limitReason>) {
    if (Number.isFinite(isolationDeadline)) {
      limited = true;
      limitReason ??= reason;
    }
    unresolved.push(...part);
  }
  async function parseFailure(part: EventRow[], error?: unknown): Promise<void> {
    if (part.length === 1) {
      rejected.push(...part);
      return;
    }
    const match = error instanceof Error ? /\(at row (\d+)\)/i.exec(error.message) : null;
    const index = match ? Number(match[1]) - 1 : -1;
    if (trustRowNumbers && Number.isSafeInteger(index) && index >= 0 && index < part.length) {
      const named = part[index] as EventRow;
      if (!rowNumberChecked) {
        rowNumberChecked = true;
        const canaryWritten = await visit([named]);
        if (!rejected.includes(named)) {
          trustRowNumbers = false;
          const rest = part.filter((row) => row !== named);
          if (canaryWritten) {
            console.warn(JSON.stringify({ level: 'warn', event: 'ingest.parse_row_number_mismatch', projectId: named.project_id }));
            // The failed parent still proves a bad row exists outside the written canary.
            await parseFailure(rest);
          } else {
            // An ambiguous, unavailable or unchecked canary cannot prove anything about its siblings.
            await visit(rest);
          }
          return;
        }
      } else rejected.push(named);
      // ClickHouse reports a statement-relative, 1-based row. Persist its parse-proven prefix
      // before continuing, so confirmed rows leave the next attempt even if a limit stops us.
      await visit(part.slice(0, index));
      await visit(part.slice(index + 1));
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
    const isolating = Number.isFinite(isolationDeadline);
    const partBytes = bytes(part);
    const reason =
      statements > MAX_PARSE_ISOLATION_STATEMENTS
        ? 'statements'
        : Date.now() >= isolationDeadline
          ? 'wall_clock'
          : Date.now() + INSERT_LEASE_BUDGET_MS > leaseExpiresAt
            ? 'lease'
            : isolating && isolationBytes + partBytes > isolationByteBudget
              ? 'bytes'
              : undefined;
    if (reason) {
      defer(part, reason);
      return false;
    }
    statements++;
    if (isolating) isolationBytes += partBytes;
    try {
      await insert(part, part.map((row) => serialized.get(row)!.line).join(''));
      written.push(...part);
      return true;
    } catch (error) {
      if (error instanceof AmbiguousInsertError) pending.push(...part);
      else if (error instanceof InsertLeaseExhaustedError) defer(part, 'lease');
      else if (isPrewriteParseError(error)) {
        isolationDeadline = Math.min(isolationDeadline, Date.now() + MAX_PARSE_ISOLATION_MS);
        await parseFailure(part, error);
      } else unavailable.push(...part);
      return false;
    }
  }
  await visit(rows);
  return { written, rejected, pending, unavailable, unresolved, limited, limitReason };
}
