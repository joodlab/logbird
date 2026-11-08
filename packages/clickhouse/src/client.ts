import { Readable } from 'node:stream';
import { type ClickHouseClient, createClient } from '@clickhouse/client';
import type { EventRow } from './normalize';

export type { ClickHouseClient } from '@clickhouse/client';
export function createClickHouseClient(env = process.env): ClickHouseClient {
  return configuredClient(env, INGEST_CLAIM_LEASE_MS);
}
export const CLICKHOUSE_MAINTENANCE_TIMEOUT_MS = 15 * 60_000;
export const CLICKHOUSE_MAINTENANCE_MAX_EXECUTION_SECONDS = 600;
const MAINTENANCE_MAX_EXECUTION_CEILING_SECONDS = 86_400;
/**
 * Server-side budget for each migration copy and cold-maintenance statement. Large installs can raise it; it can
 * never drop below the default, which every documented upgrade measurement assumes.
 */
export function maintenanceMaxExecutionSeconds(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.CLICKHOUSE_MAINTENANCE_MAX_EXECUTION_SECONDS?.trim();
  if (!raw) return CLICKHOUSE_MAINTENANCE_MAX_EXECUTION_SECONDS;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < CLICKHOUSE_MAINTENANCE_MAX_EXECUTION_SECONDS || seconds > MAINTENANCE_MAX_EXECUTION_CEILING_SECONDS)
    throw new Error(
      `CLICKHOUSE_MAINTENANCE_MAX_EXECUTION_SECONDS must be an integer from ${CLICKHOUSE_MAINTENANCE_MAX_EXECUTION_SECONDS} to ${MAINTENANCE_MAX_EXECUTION_CEILING_SECONDS}`,
    );
  return seconds;
}
/**
 * Progress headers keep the socket alive during long statements, but Node rejects a response whose headers exceed
 * 16 KiB. Each progress header is about 250 bytes; at most ~20 per statement keeps the total near 5 KiB.
 */
export function progressHeaderIntervalMs(maxExecutionSeconds: number) {
  return Math.max(30_000, Math.ceil(maxExecutionSeconds / 20) * 1000);
}
export function createMaintenanceClickHouseClient(env = process.env): ClickHouseClient {
  const maxExecutionSeconds = maintenanceMaxExecutionSeconds(env);
  // The socket-idle timeout must outlast the server budget, with room for the final response.
  const requestTimeout = Math.max(CLICKHOUSE_MAINTENANCE_TIMEOUT_MS, (maxExecutionSeconds + 300) * 1000);
  return configuredClient(env, requestTimeout, maxExecutionSeconds);
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
        : {
            max_execution_time: maxExecutionTime,
            send_progress_in_http_headers: 1,
            http_headers_progress_interval_ms: String(progressHeaderIntervalMs(maxExecutionTime)),
          }),
    },
  });
}
export const INGEST_CLAIM_LEASE_MS = 60_000;
export const ASYNC_INSERT_FLUSH_BOUND_MS = 10_000;
const INSERT_MAX_EXECUTION_SECONDS = 30;
export const CLICKHOUSE_PARSE_ERROR_CODES = new Set(['6', '27', '38', '41', '53', '69', '72']);
// Authentication/query rejection is definite; resource limits and async-wait timeouts are not.
export const CLICKHOUSE_PREWRITE_ERROR_CODES = new Set([...CLICKHOUSE_PARSE_ERROR_CODES, '60', '62', '81', '164', '497', '516']);
export class AmbiguousInsertError extends Error {
  constructor() {
    super('Storage acknowledgement is unresolved after sending the body');
    this.name = 'AmbiguousInsertError';
  }
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
        if (Date.now() + INSERT_MAX_EXECUTION_SECONDS * 1000 + ASYNC_INSERT_FLUSH_BOUND_MS > leaseExpiresAt)
          throw new Error('Insert lease lacks time to finish before expiry');
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
    const viewFailure =
      error instanceof Error &&
      (/(?:^|[(:]\s*|\n\s*)while pushing to (?:materialized )?view\b/i.test(error.message) ||
        (code === '60' && /^Target table .+ of view .+ (?:doesn't|does not) exists?\b/i.test(error.message)));
    const definite = CLICKHOUSE_PREWRITE_ERROR_CODES.has(code) && !viewFailure;
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
