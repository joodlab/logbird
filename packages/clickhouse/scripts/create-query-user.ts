import { randomBytes } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClickHouseClient } from '../src/client';

const ch = createClickHouseClient();
try {
  // Inspect privileges without emitting SHOW ACCESS authentication material.
  const grants = await (await ch.query({ query: 'SHOW GRANTS', format: 'TabSeparatedRaw' })).text();
  await (await ch.query({ query: 'SHOW ACCESS', format: 'TabSeparatedRaw' })).text();
  if (!/CREATE USER|ALL ON/.test(grants) || !/CREATE SETTINGS PROFILE|ALL ON/.test(grants))
    throw new Error('Requires CREATE USER and CREATE SETTINGS PROFILE (and SELECT grant option on Trailmark tables)');
  const files = [resolve('../../.env'), ...(process.env.TRAILMARK_PRIMARY_ENV ? [resolve(process.env.TRAILMARK_PRIMARY_ENV)] : [])];
  const contents = await Promise.all(files.map((f) => readFile(f, 'utf8')));
  const passwords = contents.map((c) => c.match(/^CLICKHOUSE_QUERY_PASSWORD=(.*)$/m)?.[1]).filter(Boolean);
  if (new Set(passwords).size > 1) throw new Error('Existing query credentials differ; refusing to replace them');
  const existing = await (await ch.query({ query: "SELECT name FROM system.users WHERE name='trailmark_query'", format: 'JSONEachRow' })).json();
  if (existing.length && !passwords.length) throw new Error('trailmark_query already exists without configured credentials; refusing to rotate');
  const password = passwords[0] ?? randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('Existing password is not in the generated credential format; refusing to modify it');
  if (contents.some((c) => /^CLICKHOUSE_QUERY_USER=(?!trailmark_query$).+$/m.test(c)))
    throw new Error('Existing query username differs; refusing to replace it');
  await ch.command({
    query: `CREATE SETTINGS PROFILE IF NOT EXISTS trailmark_query_limits SETTINGS readonly=1 CONST, allow_ddl=0 CONST, max_execution_time=10 MAX 10, max_rows_to_read=5000000 MAX 5000000, max_bytes_to_read=1073741824 MAX 1073741824, max_memory_usage=1073741824 MAX 1073741824, max_result_rows=100000 MAX 100000, result_overflow_mode='throw' CONST, read_overflow_mode='throw' CONST, timeout_overflow_mode='throw' CONST, max_query_size=65536 MAX 65536, max_ast_depth=128 MAX 128, max_threads=4 MAX 4`,
  });
  await ch.command({
    query: `CREATE USER IF NOT EXISTS trailmark_query IDENTIFIED WITH sha256_password BY '${password}' SETTINGS PROFILE trailmark_query_limits`,
  });
  for (const table of ['events', 'events_by_minute', 'entities', 'attribute_keys'])
    await ch.command({ query: `GRANT SELECT ON trailmark.${table} TO trailmark_query` });
  const actualGrants = await (await ch.query({ query: 'SHOW GRANTS FOR trailmark_query', format: 'TabSeparatedRaw' })).text();
  if (
    actualGrants
      .trim()
      .split('\n')
      .some((line) => !/^GRANT SELECT ON trailmark\.(events|events_by_minute|entities|attribute_keys) TO trailmark_query$/.test(line))
  )
    throw new Error('Query user has unexpected grants; operator review required');
  for (let i = 0; i < files.length; i++) {
    let addition = '';
    if (!/^CLICKHOUSE_QUERY_USER=/m.test(contents[i]!)) addition += '\nCLICKHOUSE_QUERY_USER=trailmark_query';
    if (!/^CLICKHOUSE_QUERY_PASSWORD=/m.test(contents[i]!)) addition += `\nCLICKHOUSE_QUERY_PASSWORD=${password}`;
    if (addition) await appendFile(files[i]!, `${addition}\n`);
  }
  console.log('Restricted Trailmark query user ready; credentials appended without replacing existing keys.');
} finally {
  await ch.close();
}
