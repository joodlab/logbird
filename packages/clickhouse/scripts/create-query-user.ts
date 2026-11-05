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
  const files = process.env.CLICKHOUSE_QUERY_PASSWORD
    ? []
    : [resolve('../../.env'), ...(process.env.TRAILMARK_PRIMARY_ENV ? [resolve(process.env.TRAILMARK_PRIMARY_ENV)] : [])];
  const contents = await Promise.all(files.map((f) => readFile(f, 'utf8')));
  const passwords = [process.env.CLICKHOUSE_QUERY_PASSWORD, ...contents.map((c) => c.match(/^CLICKHOUSE_QUERY_PASSWORD=(.*)$/m)?.[1])].filter(
    Boolean,
  );
  if (new Set(passwords).size > 1) throw new Error('Existing query credentials differ; refusing to replace them');
  const existing = await (await ch.query({ query: "SELECT name FROM system.users WHERE name='trailmark_query'", format: 'JSONEachRow' })).json();
  if (existing.length && !passwords.length) throw new Error('trailmark_query already exists without configured credentials; refusing to rotate');
  const password = passwords[0] ?? randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('Existing password is not in the generated credential format; refusing to modify it');
  if (
    (process.env.CLICKHOUSE_QUERY_USER && process.env.CLICKHOUSE_QUERY_USER !== 'trailmark_query') ||
    contents.some((c) => /^CLICKHOUSE_QUERY_USER=(?!trailmark_query$).+$/m.test(c))
  )
    throw new Error('Existing query username differs; refusing to replace it');
  if (existing.length) {
    const existingUser = createClickHouseClient({ ...process.env, CLICKHOUSE_USER: 'trailmark_query', CLICKHOUSE_PASSWORD: password });
    try {
      await (await existingUser.query({ query: 'SELECT 1' })).text();
    } catch {
      throw new Error('Existing query credentials do not authenticate; refusing to rotate');
    } finally {
      await existingUser.close();
    }
  }
  // SQL_ is ClickHouse's built-in custom-setting prefix on 26.9. Probe rather
  // than changing server configuration (it may not appear in server_settings).
  await (
    await ch.query({ query: "SELECT getSetting('SQL_trailmark_project')", clickhouse_settings: { SQL_trailmark_project: '__provision__' } })
  ).text();
  const tables = ['events', 'events_by_minute', 'entities', 'attribute_keys'];
  const before = new Map<string, string>();
  for (const table of tables)
    before.set(table, await (await ch.query({ query: `SELECT count() FROM trailmark.${table}`, format: 'TabSeparatedRaw' })).text());
  const limits =
    "readonly=2 CONST, allow_ddl=0 CONST, max_execution_time=10 CONST, max_rows_to_read=5000000 CONST, max_bytes_to_read=1073741824 CONST, max_memory_usage=1073741824 CONST, max_result_rows=100000 CONST, result_overflow_mode='throw' CONST, read_overflow_mode='throw' CONST, timeout_overflow_mode='throw' CONST, max_query_size=65536 CONST, max_ast_depth=128 CONST, max_threads=4 CONST";
  await ch.command({
    query: `CREATE SETTINGS PROFILE IF NOT EXISTS trailmark_query_limits SETTINGS ${limits}`,
  });
  // CREATE IF NOT EXISTS alone would leave an existing readonly=1 profile unchanged.
  await ch.command({ query: `ALTER SETTINGS PROFILE trailmark_query_limits SETTINGS ${limits}` });
  await ch.command({
    query: `CREATE USER IF NOT EXISTS trailmark_query IDENTIFIED WITH sha256_password BY '${password}' SETTINGS PROFILE trailmark_query_limits`,
  });
  for (const table of tables) await ch.command({ query: `GRANT SELECT ON trailmark.${table} TO trailmark_query` });
  await ch.command({ query: 'ALTER USER trailmark_query SETTINGS PROFILE trailmark_query_limits' });
  for (const table of tables) {
    // Install the companion first: versions/configurations that default-deny users
    // without a policy must not hide the main application's data during provisioning.
    await ch.command({ query: `CREATE ROW POLICY IF NOT EXISTS trailmark_unrestricted ON trailmark.${table} USING 1 TO ALL EXCEPT trailmark_query` });
    await ch.command({
      query: `CREATE ROW POLICY IF NOT EXISTS trailmark_project_isolation ON trailmark.${table} USING project_id = getSetting('SQL_trailmark_project') TO trailmark_query`,
    });
    await ch.command({ query: `ALTER ROW POLICY trailmark_unrestricted ON trailmark.${table} USING 1 TO ALL EXCEPT trailmark_query` });
    await ch.command({
      query: `ALTER ROW POLICY trailmark_project_isolation ON trailmark.${table} USING project_id = getSetting('SQL_trailmark_project') TO trailmark_query`,
    });
    const after = await (await ch.query({ query: `SELECT count() FROM trailmark.${table}`, format: 'TabSeparatedRaw' })).text();
    if (after !== before.get(table)) throw new Error(`Main-user row count changed for ${table}; check concurrent ingestion before retrying`);
  }
  const actualGrants = await (await ch.query({ query: 'SHOW GRANTS FOR trailmark_query', format: 'TabSeparatedRaw' })).text();
  if (
    actualGrants
      .trim()
      .split('\n')
      .some((line) => !/^GRANT SELECT ON trailmark\.(events|events_by_minute|entities|attribute_keys) TO trailmark_query$/.test(line))
  )
    throw new Error('Query user has unexpected grants; operator review required');
  const probe = createClickHouseClient({ ...process.env, CLICKHOUSE_USER: 'trailmark_query', CLICKHOUSE_PASSWORD: password });
  try {
    const settings = await (
      await probe.query({
        query:
          "SELECT name,value FROM system.settings WHERE name IN ('readonly','allow_ddl','max_execution_time','max_memory_usage','max_rows_to_read','max_bytes_to_read','max_result_rows','result_overflow_mode','timeout_overflow_mode','read_overflow_mode')",
        format: 'JSONEachRow',
      })
    ).json<{ name: string; value: string }>();
    const expected: Record<string, string> = {
      readonly: '2',
      allow_ddl: '0',
      max_execution_time: '10',
      max_memory_usage: '1073741824',
      max_rows_to_read: '5000000',
      max_bytes_to_read: '1073741824',
      max_result_rows: '100000',
      result_overflow_mode: 'throw',
      timeout_overflow_mode: 'throw',
      read_overflow_mode: 'throw',
    };
    if (settings.length !== Object.keys(expected).length || settings.some((s) => expected[s.name] !== s.value))
      throw new Error('Existing query profile settings differ; operator review required');
  } finally {
    await probe.close();
  }
  for (let i = 0; i < files.length; i++) {
    let addition = '';
    if (!/^CLICKHOUSE_QUERY_USER=/m.test(contents[i]!)) addition += '\nCLICKHOUSE_QUERY_USER=trailmark_query';
    if (!/^CLICKHOUSE_QUERY_PASSWORD=/m.test(contents[i]!)) addition += `\nCLICKHOUSE_QUERY_PASSWORD=${password}`;
    if (addition) await appendFile(files[i]!, `${addition}\n`);
  }
  console.log('Restricted Trailmark query user ready; configured credentials preserved.');
} finally {
  await ch.close();
}
