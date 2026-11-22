import { expect, it } from 'vitest';
import { createQueryClickHouseClient, withoutUrlCredentials } from './client';

it('#138 phase 2: restricted clients drop URL credentials and keep everything else as written', () => {
  expect(withoutUrlCredentials(undefined)).toBeUndefined();
  expect(withoutUrlCredentials('')).toBe('');
  // Without userinfo the value is returned untouched, including a trailing slash inside a query option.
  for (const url of ['http://clickhouse:8123', 'http://clickhouse:8123/?pathname=/proxy/', 'https://[::1]:8443/logbird'])
    expect(withoutUrlCredentials(url)).toBe(url);
  expect(withoutUrlCredentials('http://main:secret@clickhouse:8123')).toBe('http://clickhouse:8123/');
  expect(withoutUrlCredentials('https://main:secret@[::1]:8443/logbird?pathname=/proxy/')).toBe('https://[::1]:8443/logbird?pathname=/proxy/');
});

it('builds a restricted client when CLICKHOUSE_URL is unset (the driver default applies)', async () => {
  const client = createQueryClickHouseClient({ CLICKHOUSE_QUERY_USER: 'logbird_query', CLICKHOUSE_QUERY_PASSWORD: 'x'.repeat(64) });
  expect(client).not.toBeNull();
  await client?.close();
});
