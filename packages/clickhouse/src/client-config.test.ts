import { beforeEach, expect, it, vi } from 'vitest';
import {
  createClickHouseClient,
  createMaintenanceClickHouseClient,
  createQueryClickHouseClient,
  maintenanceMaxExecutionSeconds,
  progressHeaderIntervalMs,
} from './client';

const captured = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock('@clickhouse/client', () => ({
  createClient: (options: Record<string, unknown>) => {
    captured.options.push(options);
    return {};
  },
}));
beforeEach(() => {
  captured.options.length = 0;
});
it('keeps ingest and restricted-read clients at a 60-second idle timeout', () => {
  createClickHouseClient({});
  createQueryClickHouseClient({ CLICKHOUSE_QUERY_USER: 'qa', CLICKHOUSE_QUERY_PASSWORD: 'fixture' });
  expect(captured.options).toHaveLength(2);
  for (const options of captured.options) {
    expect(options.request_timeout).toBe(60_000);
    expect(options.clickhouse_settings).not.toHaveProperty('max_execution_time');
  }
});
it('lets maintenance consume its ten-minute server budget without a one-minute idle abort', () => {
  createMaintenanceClickHouseClient({});
  expect(captured.options[0]).toMatchObject({
    request_timeout: 900_000,
    clickhouse_settings: { max_execution_time: 600, http_headers_progress_interval_ms: '30000' },
  });
});
it('raises the maintenance budget only upwards and keeps progress headers under Node header limits', () => {
  createMaintenanceClickHouseClient({ CLICKHOUSE_MAINTENANCE_MAX_EXECUTION_SECONDS: '3600' });
  expect(captured.options[0]).toMatchObject({
    request_timeout: 3_900_000,
    clickhouse_settings: { max_execution_time: 3600, http_headers_progress_interval_ms: '180000' },
  });
  expect(maintenanceMaxExecutionSeconds({})).toBe(600);
  expect(maintenanceMaxExecutionSeconds({ CLICKHOUSE_MAINTENANCE_MAX_EXECUTION_SECONDS: ' ' })).toBe(600);
  for (const value of ['599', '60', '86401', '1.5', 'ten minutes'])
    expect(() => maintenanceMaxExecutionSeconds({ CLICKHOUSE_MAINTENANCE_MAX_EXECUTION_SECONDS: value })).toThrow(/600 to 86400/);
  // About 250 bytes per progress header: at most ~20 headers per statement for any accepted budget.
  for (const seconds of [600, 1800, 3600, 86_400]) expect((seconds * 1000) / progressHeaderIntervalMs(seconds)).toBeLessThanOrEqual(20);
});
