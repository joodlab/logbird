import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClickHouseClient } from '@logbird/clickhouse';
import Redis from 'ioredis';
import pg from 'pg';
import { provisionQueryUser } from '../packages/clickhouse/src/provision-query-user';

const flags = new Set(process.argv.slice(2));
for (const flag of flags)
  if (!['--dry-run', '--yes', '--include-local-fixtures', '--drop-old-redis-keys'].includes(flag)) throw new Error(`Unknown flag: ${flag}`);
if (flags.has('--yes') && flags.has('--dry-run')) throw new Error('Choose --dry-run or --yes');
const execute = flags.has('--yes');
console.log(
  `${execute ? 'Execute' : 'Dry run'}: stop all writers/workers and take verified backups first. No connections are terminated by this tool.`,
);
console.log(
  'Plan: rename Postgres database/SQL role; journal and move ClickHouse tables/views with count verification; rebuild view bindings; migrate sample/attribute labels; provision restricted access; remove old access objects and empty database.',
);
console.log(
  'Environment changes (names only): TRAILMARK_* -> LOGBIRD_*; DATABASE_URL database/user -> logbird; POSTGRES_DB, POSTGRES_USER, CLICKHOUSE_DATABASE, CLICKHOUSE_USER -> logbird; CLICKHOUSE_QUERY_USER -> logbird_query; BULLMQ_PREFIX -> {logbird}. Keep all passwords and API keys. Update server-configured ClickHouse admin identity separately.',
);
console.log(
  'Old {trailmark} Redis keys remain unless --drop-old-redis-keys; repeatable retention jobs register on worker startup. Sessions require sign-in again; localStorage starts fresh.',
);
const maintenance = new URL(process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || '');
maintenance.pathname = '/postgres';
const db = new pg.Client({ connectionString: maintenance.toString() });
const ch = createClickHouseClient({ ...process.env, CLICKHOUSE_DATABASE: 'default' });
const ident = (s: string) => `\`${s.replaceAll('`', '\\`')}\``;
const rows = async <T>(query: string) => (await ch.query({ query, format: 'JSONEachRow' })).json<T>();
const count = async (database: string, table: string) =>
  (await rows<{ n: string }>(`SELECT toString(count()) n FROM ${ident(database)}.${ident(table)}`))[0]?.n ??
  (() => {
    throw new Error('Missing count result');
  })();
let redis: Redis | undefined;
try {
  await db.connect();
  const clients = (
    await db.query(
      "SELECT pid, usename, application_name, client_addr, state FROM pg_stat_activity WHERE datname IN ('trailmark','logbird') AND pid <> pg_backend_pid()",
    )
  ).rows;
  if (clients.length) throw new Error(`Stop connected clients before retrying: ${JSON.stringify(clients)}`);
  const databases = (await db.query("SELECT datname FROM pg_database WHERE datname IN ('trailmark','logbird')")).rows.map(
    (r: { datname: string }) => r.datname,
  );
  if (!databases.length) throw new Error('Neither expected Postgres database exists; refusing to initialize an empty install');
  if (databases.length === 2) throw new Error('Both Postgres databases exist; reconcile manually; refusing to overwrite');
  const roles = (await db.query("SELECT rolname FROM pg_roles WHERE rolname IN ('trailmark','logbird')")).rows.map(
    (r: { rolname: string }) => r.rolname,
  );
  if (
    roles.includes('trailmark') &&
    (await db.query("SELECT rolpassword LIKE 'md5%' AS legacy FROM pg_authid WHERE rolname='trailmark'")).rows[0]?.legacy
  )
    throw new Error(
      'Legacy MD5 role password detected: PostgreSQL clears it on role rename. Re-provision the same password as SCRAM with your administrator before retrying, or use the documented dump/restore alternative. No password was changed.',
    );
  if (roles.includes('trailmark') && roles.includes('logbird')) throw new Error('Both Postgres roles exist; reconcile manually');
  if (roles.includes('trailmark') && (await db.query('SELECT current_user u')).rows[0].u === 'trailmark')
    throw new Error(
      'Use MIGRATION_DATABASE_URL with a different administrator role to rename trailmark; PostgreSQL cannot rename the session user. No password is changed.',
    );
  if (!process.env.CLICKHOUSE_QUERY_PASSWORD) throw new Error('Configure the existing CLICKHOUSE_QUERY_PASSWORD; credentials are never regenerated');
  const tables = await rows<{ name: string; engine: string; create_table_query: string }>(
    "SELECT name,engine,create_table_query FROM system.tables WHERE database='trailmark' ORDER BY name",
  );
  if (!(await rows("SELECT name FROM system.tables WHERE database IN ('trailmark','logbird') AND name='events'")).length)
    throw new Error('No existing events table; refusing empty-install migration');
  const journalPath = process.env.LOGBIRD_MIGRATION_STATE_FILE || '.tmp/namespace-migration.json';
  type Entry = { name: string; engine: string; create_table_query: string; count: string | null };
  const identity = JSON.stringify({
    postgres: maintenance.host,
    clickhouse: new URL(process.env.CLICKHOUSE_URL || '').origin,
    databaseOid: (await db.query("SELECT oid FROM pg_database WHERE datname IN ('trailmark','logbird')")).rows[0].oid,
  });
  let journal: Entry[];
  try {
    const saved = JSON.parse(await readFile(journalPath, 'utf8'));
    if (saved.identity !== identity) throw new Error('Migration journal belongs to a different installation; refusing to proceed');
    journal = saved.entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    journal = [];
  }
  if (!journal.length && tables.length) {
    for (const table of tables) {
      if (
        (
          await rows<{ name: string }>(
            `SELECT name FROM system.tables WHERE database='logbird' AND name={name:String}`.replace(
              '{name:String}',
              `'${table.name.replaceAll("'", "\\'")}'`,
            ),
          )
        ).length
      )
        throw new Error(`Target table exists: ${table.name}`);
      journal.push({ ...table, count: table.engine === 'MaterializedView' ? null : await count('trailmark', table.name) });
    }
    if (execute) {
      await mkdir(dirname(journalPath), { recursive: true });
      await writeFile(journalPath, JSON.stringify({ identity, entries: journal }, null, 2));
    }
  }
  console.log(
    `Postgres: ${databases.join(', ')}; ClickHouse: ${tables.length} old objects, ${journal.length} journal entries; fixtures ${flags.has('--include-local-fixtures') ? 'included' : 'unchanged'}.`,
  );
  if (execute) {
    if (databases.includes('trailmark')) await db.query('ALTER DATABASE trailmark RENAME TO logbird');
    if (roles.includes('trailmark')) await db.query('ALTER ROLE trailmark RENAME TO logbird');
    await ch.command({ query: 'CREATE DATABASE IF NOT EXISTS logbird' });
    for (const entry of journal) {
      if (tables.some((t) => t.name === entry.name))
        await ch.command({ query: `RENAME TABLE trailmark.${ident(entry.name)} TO logbird.${ident(entry.name)}` });
      if (entry.count !== null && (await count('logbird', entry.name)) !== entry.count)
        throw new Error(`Row count mismatch: ${entry.name}; preserve backups and journal, stop and investigate`);
      console.log(`Verified ${entry.name}: ${entry.count} rows`);
    }
    const target = createClickHouseClient({ ...process.env, CLICKHOUSE_DATABASE: 'logbird' });
    try {
      await provisionQueryUser(target, process.env.CLICKHOUSE_QUERY_PASSWORD);
      // A concurrent mutation can be skipped while reporting done (ClickHouse#124167): re-run until no row matches.
      const updateUntilClear = async (update: string, remaining: string) => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          await target.command({ query: update, clickhouse_settings: { mutations_sync: '2' } });
          if (!Number((await rows<{ n: string }>(remaining))[0]?.n ?? 0)) return;
          console.warn(`Update left matching rows after attempt ${attempt}; re-running (${remaining})`);
        }
        throw new Error(`Update left matching rows (${remaining}); preserve backups and journal, stop and investigate`);
      };
      await updateUntilClear(
        "ALTER TABLE logbird.events UPDATE source='logbird-sample' WHERE source='trailmark-sample'",
        "SELECT toString(count()) n FROM logbird.events WHERE source='trailmark-sample'",
      );
      await updateUntilClear(
        "ALTER TABLE logbird.events UPDATE attributes=mapUpdate(mapFilter((k,v) -> k != 'trailmark.occurredAt.rejected', attributes), map('logbird.occurredAt.rejected', attributes['trailmark.occurredAt.rejected'])) WHERE mapContains(attributes,'trailmark.occurredAt.rejected')",
        "SELECT toString(count()) n FROM logbird.events WHERE mapContains(attributes,'trailmark.occurredAt.rejected')",
      );
      if ((await rows<{ n: number }>("SELECT count() n FROM logbird.attribute_keys WHERE key='trailmark.occurredAt.rejected'"))[0]?.n) {
        await target.command({ query: 'DROP TABLE IF EXISTS logbird.namespace_attribute_keys' });
        await target.command({ query: 'CREATE TABLE logbird.namespace_attribute_keys AS logbird.attribute_keys' });
        await target.command({
          query:
            "INSERT INTO logbird.namespace_attribute_keys SELECT * REPLACE (if(key='trailmark.occurredAt.rejected','logbird.occurredAt.rejected',key) AS key) FROM logbird.attribute_keys",
          clickhouse_settings: { optimize_on_insert: 0 },
        });
        if ((await count('logbird', 'namespace_attribute_keys')) !== (await count('logbird', 'attribute_keys')))
          throw new Error('Attribute staging count differs; original preserved');
        await target.command({ query: 'EXCHANGE TABLES logbird.attribute_keys AND logbird.namespace_attribute_keys' });
        await target.command({ query: 'DROP TABLE logbird.namespace_attribute_keys' });
      }
    } finally {
      await target.close();
    }
    // Moving a materialized view preserves UUID bindings but its SELECT can still name the old database.
    for (const entry of journal.filter((e) => e.engine === 'MaterializedView')) {
      const ddl = entry.create_table_query.replaceAll('trailmark.', 'logbird.');
      await ch.command({ query: `DROP VIEW IF EXISTS logbird.${ident(entry.name)}` });
      await ch.command({ query: ddl });
    }
    for (const entry of journal)
      if (entry.count !== null && (await count('logbird', entry.name)) !== entry.count) throw new Error(`Final row count mismatch: ${entry.name}`);
    const policies = await rows<{ name: string; database: string; table: string }>(
      // `name` is the full "short ON db.table" form; DROP needs the short name or IF EXISTS silently matches nothing.
      "SELECT short_name AS name,database,table FROM system.row_policies WHERE startsWith(short_name,'trailmark_') AND database IN ('trailmark','logbird')",
    );
    for (const p of policies) await ch.command({ query: `DROP ROW POLICY IF EXISTS ${ident(p.name)} ON ${ident(p.database)}.${ident(p.table)}` });
    await ch.command({ query: 'DROP USER IF EXISTS trailmark_query' });
    await ch.command({ query: 'DROP SETTINGS PROFILE IF EXISTS trailmark_query_limits' });
    if ((await rows("SELECT name FROM system.tables WHERE database='trailmark'")).length)
      throw new Error('Old database is not empty; refusing to drop');
    await ch.command({ query: 'DROP DATABASE IF EXISTS trailmark' });
    if (flags.has('--include-local-fixtures')) {
      const url = new URL(maintenance);
      url.pathname = '/logbird';
      const fixtures = new pg.Client({ connectionString: url.toString() });
      try {
        await fixtures.connect();
        await fixtures.query(
          `UPDATE "user" SET email=regexp_replace(email, '@trailmark[.]local$', '@logbird.local') WHERE email LIKE '%@trailmark.local'`,
        );
      } finally {
        await fixtures.end();
      }
    }
    if (flags.has('--drop-old-redis-keys')) {
      redis = new Redis(process.env.REDIS_URL || '');
      let cursor = '0',
        deleted = 0;
      do {
        const result = await redis.scan(cursor, 'MATCH', '{trailmark}*', 'COUNT', 500);
        cursor = result[0];
        const keys = result[1].filter((key) => key.startsWith('{trailmark}'));
        if (keys.length) deleted += await redis.del(...keys);
      } while (cursor !== '0');
      console.log(`Deleted ${deleted} keys with exact old prefix.`);
    }
    // Remove the journal only after the operator has retained evidence/backups. Re-running verifies it again.
    await rename(journalPath, `${journalPath}.completed`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    console.log('Migration verified. Keep the journal with the backup. Apply env changes and restart Logbird.');
  }
} finally {
  await Promise.allSettled([db.end(), ch.close(), redis?.quit()]);
}
