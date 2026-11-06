import { type ClickHouseClient, createClickHouseClient } from './client';
export async function provisionQueryUser(ch: ClickHouseClient, password: string) {
  if (!password) throw new Error('CLICKHOUSE_QUERY_PASSWORD is required; existing credentials must be reused');
  const escapedPassword = password.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  const tables = ['events', 'events_by_minute', 'entities', 'attribute_keys'];
  // SQL_ is ClickHouse's built-in custom-setting prefix on 26.9. Probe rather
  // than changing server configuration (it may not appear in server_settings).
  await (await ch.query({ query: "SELECT getSetting('SQL_logbird_project')", clickhouse_settings: { SQL_logbird_project: '__provision__' } })).text();

  const before = new Map<string, string>();
  for (const table of tables)
    before.set(table, await (await ch.query({ query: `SELECT count() FROM logbird.${table}`, format: 'TabSeparatedRaw' })).text());
  const limits =
    "readonly=2 CONST, allow_ddl=0 CONST, max_execution_time=10 CONST, max_rows_to_read=5000000 CONST, max_bytes_to_read=1073741824 CONST, max_memory_usage=1073741824 CONST, max_result_rows=100000 CONST, result_overflow_mode='throw' CONST, read_overflow_mode='throw' CONST, timeout_overflow_mode='throw' CONST, max_query_size=65536 CONST, max_ast_depth=128 CONST, max_threads=4 CONST";
  await ch.command({
    query: `CREATE SETTINGS PROFILE IF NOT EXISTS logbird_query_limits SETTINGS ${limits}`,
  });
  // CREATE IF NOT EXISTS alone would leave an existing readonly=1 profile unchanged.
  await ch.command({ query: `ALTER SETTINGS PROFILE logbird_query_limits SETTINGS ${limits}` });
  await ch.command({
    query: `CREATE USER IF NOT EXISTS logbird_query IDENTIFIED WITH sha256_password BY '${escapedPassword}' SETTINGS PROFILE logbird_query_limits`,
  });
  for (const table of tables) await ch.command({ query: `GRANT SELECT ON logbird.${table} TO logbird_query` });
  await ch.command({ query: 'ALTER USER logbird_query SETTINGS PROFILE logbird_query_limits' });
  for (const table of tables) {
    // Install the companion first: versions/configurations that default-deny users
    // without a policy must not hide the main application's data during provisioning.
    await ch.command({ query: `CREATE ROW POLICY IF NOT EXISTS logbird_unrestricted ON logbird.${table} USING 1 TO ALL EXCEPT logbird_query` });
    await ch.command({
      query: `CREATE ROW POLICY IF NOT EXISTS logbird_project_isolation ON logbird.${table} USING project_id = getSetting('SQL_logbird_project') TO logbird_query`,
    });
    await ch.command({ query: `ALTER ROW POLICY logbird_unrestricted ON logbird.${table} USING 1 TO ALL EXCEPT logbird_query` });
    await ch.command({
      query: `ALTER ROW POLICY logbird_project_isolation ON logbird.${table} USING project_id = getSetting('SQL_logbird_project') TO logbird_query`,
    });
    const after = await (await ch.query({ query: `SELECT count() FROM logbird.${table}`, format: 'TabSeparatedRaw' })).text();
    if (after !== before.get(table)) throw new Error(`Main-user row count changed for ${table}; check concurrent ingestion before retrying`);
  }
  const actualGrants = await (await ch.query({ query: 'SHOW GRANTS FOR logbird_query', format: 'TabSeparatedRaw' })).text();
  if (
    actualGrants
      .trim()
      .split('\n')
      .some((line) => !/^GRANT SELECT ON logbird\.(events|events_by_minute|entities|attribute_keys) TO logbird_query$/.test(line))
  )
    throw new Error('Query user has unexpected grants; operator review required');
  const probe = createClickHouseClient({
    ...process.env,
    CLICKHOUSE_DATABASE: 'logbird',
    CLICKHOUSE_USER: 'logbird_query',
    CLICKHOUSE_PASSWORD: password,
  });
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
}
