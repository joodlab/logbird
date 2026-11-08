import { beforeEach, expect, it, vi } from 'vitest';
import { createClickHouseClient, createMaintenanceClickHouseClient, createQueryClickHouseClient } from './client';

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
  expect(captured.options[0]).toMatchObject({ request_timeout: 900_000, clickhouse_settings: { max_execution_time: 600 } });
});
