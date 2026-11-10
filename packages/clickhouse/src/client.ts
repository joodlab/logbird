import { Readable } from 'node:stream';
import { type ClickHouseClient, createClient } from '@clickhouse/client';
import type { EventRow } from './normalize';

export type { ClickHouseClient } from '@clickhouse/client';
export function createClickHouseClient(env = process.env): ClickHouseClient {
  return configuredClient(env, INGEST_CLAIM_LEASE_MS);
}
export const CLICKHOUSE_MAINTENANCE_TIMEOUT_MS = 15 * 60_000;
export const CLICKHOUSE_MAINTENANCE_MAX_EXECUTION_SECONDS = 600;
export function createMaintenanceClickHouseClient(env = process.env): ClickHouseClient {
  return configuredClient(env, CLICKHOUSE_MAINTENANCE_TIMEOUT_MS, CLICKHOUSE_MAINTENANCE_MAX_EXECUTION_SECONDS);
}
function configuredClient(env: NodeJS.ProcessEnv, requestTimeout: number, maxExecutionTime?: number): ClickHouseClient {
  return createClient({
    url: env.CLICKHOUSE_URL,
    database: env.CLICKHOUSE_DATABASE,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
    // This is a socket-idle timeout for every operation, independent of the INSERT lease.
    request_timeout: requestTimeout,
    clickhouse_settings: {
      date_time_input_format: 'best_effort',
      output_format_json_quote_64bit_integers: 0,
      ...(maxExecutionTime === undefined
        ? {}
        : { max_execution_time: maxExecutionTime, send_progress_in_http_headers: 1, http_headers_progress_interval_ms: '10000' }),
    },
  });
}
export const INGEST_CLAIM_LEASE_MS = 60_000;
export const ASYNC_INSERT_FLUSH_BOUND_MS = 10_000;
const INSERT_MAX_EXECUTION_SECONDS = 30;
export const INSERT_LEASE_BUDGET_MS = INSERT_MAX_EXECUTION_SECONDS * 1000 + ASYNC_INSERT_FLUSH_BOUND_MS;
export const CLICKHOUSE_PARSE_ERROR_CODES = new Set(['6', '25', '27', '38', '41', '53', '69', '72']);
// Authentication/query rejection is definite; resource limits and async-wait timeouts are not.
export const CLICKHOUSE_PREWRITE_ERROR_CODES = new Set([...CLICKHOUSE_PARSE_ERROR_CODES, '60', '62', '81', '164', '497', '516']);
export class AmbiguousInsertError extends Error {
  constructor() {
    super('Storage acknowledgement is unresolved after sending the body');
    this.name = 'AmbiguousInsertError';
  }
}
export function isPrewriteParseError(error: unknown) {
  return (
    !(error instanceof AmbiguousInsertError) &&
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    CLICKHOUSE_PARSE_ERROR_CODES.has(String(error.code)) &&
    !isViewFailure(error)
  );
}

function isViewFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  return (
    /(?:^|[(:]\s*|\n\s*)while pushing to (?:materialized )?view\b/i.test(error.message) ||
    ('code' in error && String(error.code) === '60' && /^Target table .+ of view .+ (?:doesn't|does not) exists?\b/i.test(error.message))
  );
}
export async function insertEvents(ch: ClickHouseClient, rows: EventRow[], leaseExpiresAt = Date.now() + INGEST_CLAIM_LEASE_MS) {
  if (!rows.length) return;
  let bodySent = false;
  // A single byte body avoids the client's per-row object transform/backpressure pipeline.
  // Keep serialization and the lease check lazy: socket acquisition can be delayed.
  const values = new Readable({
    read() {
      try {
        const body = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
        if (Date.now() + INSERT_LEASE_BUDGET_MS > leaseExpiresAt) throw new Error('Insert lease lacks time to finish before expiry');
        bodySent = true;
        this.push(body);
        this.push(null);
      } catch (error) {
        this.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  try {
    if (Date.now() >= leaseExpiresAt) throw new Error('Insert lease expired before sending');
    const result = await ch.exec({
      query: 'INSERT INTO events FORMAT JSONEachRow',
      values,
      abort_signal: AbortSignal.timeout(Math.max(1, leaseExpiresAt - Date.now())),
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 1,
        max_execution_time: INSERT_MAX_EXECUTION_SECONDS,
        async_insert_busy_timeout_max_ms: 1000,
        wait_for_async_insert_timeout: 40,
      },
    });
    // exec owns a response stream; acknowledgement is complete only after consuming it.
    for await (const _chunk of result.stream) {
      /* INSERT has no result rows. */
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    // The same parse code can originate inside a failing MV after the source row was written.
    const definite = CLICKHOUSE_PREWRITE_ERROR_CODES.has(code) && !isViewFailure(error);
    if (bodySent && !definite) throw new AmbiguousInsertError();
    throw error;
  } finally {
    values.destroy();
  }
}

const restricted = new WeakSet<ClickHouseClient>();
export function createQueryClickHouseClient(env = process.env): ClickHouseClient | null {
  if (!env.CLICKHOUSE_QUERY_USER || !env.CLICKHOUSE_QUERY_PASSWORD) return null;
  const client = createClickHouseClient({ ...env, CLICKHOUSE_USER: env.CLICKHOUSE_QUERY_USER, CLICKHOUSE_PASSWORD: env.CLICKHOUSE_QUERY_PASSWORD });
  restricted.add(client);
  return client;
}
export function isQueryClient(ch: ClickHouseClient) {
  return restricted.has(ch);
}
