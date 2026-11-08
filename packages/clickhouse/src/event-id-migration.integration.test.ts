import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { it } from 'vitest';
import { createClickHouseClient, insertEvents } from './client';
import { migrateEventIdIndex } from './event-id-migration';
import { canonicalFingerprint, existingEventIdentities } from './identity';
import { migrate } from './migrations';
import { normalizeEvent } from './normalize';

const database = 'logbird_qa_062',
  owner = 'event-id migration fixture';
const run = process.env.CLICKHOUSE_ONLINE_MIGRATION_TEST === '1';
it.skipIf(!run)(
  'upgrades online and resumes after every durable phase with concurrent writers',
  async () => {
    const ch = createClickHouseClient({ ...process.env, CLICKHOUSE_DATABASE: database });
    const read = async <T>(query: string) => (await ch.query({ query, format: 'JSONEachRow' })).json<T>();
    const statements = async (name: string) =>
      (await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
    const now = new Date();
    let serial = 0;
    const row = (id: string, at = now, receivedAt = now) => {
      const n = normalizeEvent(
        { id, action: id === 'legacy' ? 'customer.original' : 'qa.concurrent', occurredAt: at.toISOString() },
        { projectId: 'qa-online-062', receivedAt },
      );
      assert.ok(n.ok);
      return n.row;
    };
    const report: unknown[] = [];
    try {
      const present = await (
        await ch.query({ query: 'SELECT name,engine,comment FROM system.databases WHERE name=currentDatabase()', format: 'JSONEachRow' })
      ).json<{ name: string; engine: string; comment: string }>();
      assert.equal(present[0]?.name, database);
      assert.equal(present[0]?.engine, 'Atomic');
      assert.equal(present[0]?.comment, owner, 'Explicitly create an owned throwaway DB before this test');
      // Initialize only the old migrations so each online attempt starts on the replacing index.
      for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter((n) => n.endsWith('.sql') && n < '007').sort()) {
        for (const query of await statements(name)) await ch.command({ query });
      }
      await ch.command({
        query: 'CREATE TABLE IF NOT EXISTS migrations (name String,applied_at DateTime DEFAULT now()) ENGINE=MergeTree ORDER BY name',
      });
      await ch.insert({
        table: 'migrations',
        format: 'JSONEachRow',
        values: (await readdir(new URL('../migrations/', import.meta.url))).filter((n) => n.endsWith('.sql') && n < '007').map((name) => ({ name })),
      });
      const old = row('legacy', new Date(now.getTime() - 20_000), new Date(now.getTime() - 10_000));
      await insertEvents(ch, [old, row('legacy', new Date(now.getTime() - 5000))]);
      const ddl = await statements('006_event_ids.sql');
      const online = await statements('007_event_ids_merge_tree.sql');
      for (let fault = -1; fault < 7; fault++) {
        if (fault >= 0) {
          for (const query of [
            'DROP VIEW IF EXISTS event_ids_v2_mv SYNC',
            'DROP VIEW IF EXISTS event_ids_mv SYNC',
            'DROP TABLE IF EXISTS event_ids_v2 SYNC',
            'DROP TABLE IF EXISTS event_ids SYNC',
          ])
            await ch.command({ query });
          for (const query of ddl) await ch.command({ query });
          await ch.command({ query: "ALTER TABLE migrations DELETE WHERE name='007_event_ids_merge_tree.sql' SETTINGS mutations_sync=2" });
        }
        await ch.command({ query: 'OPTIMIZE TABLE event_ids FINAL' });
        const command = ch.command.bind(ch);
        let phase = 0,
          armed = fault >= 0;
        ch.command = async (params) => {
          const result = await command(params);
          if (armed && online.includes(params.query) && phase++ === fault) {
            armed = false;
            throw new Error('Injected interruption after durable migration step');
          }
          return result;
        };
        const writer = (async () => {
          for (let i = 0; i < 30; i++) {
            await insertEvents(ch, [row(`concurrent-${serial++}`)]);
            await new Promise((r) => setTimeout(r, 5));
          }
        })().then(
          () => ({ ok: true, error: undefined }),
          (error) => ({ ok: false, error }),
        );
        if (fault >= 0) await assert.rejects(migrate(ch), /Injected interruption/);
        else await migrate(ch);
        ch.command = command;
        await migrate(ch);
        const written = await writer;
        assert.ok(written.ok, String(written.error));
        const after = `after-${fault}`;
        await insertEvents(ch, [row(after)]);
        const counts = await read<{ events: number; ids: number; index_ids: number; missing: number }>(
          'SELECT (SELECT count() FROM events) events,(SELECT uniqExact((project_id,event_id)) FROM events) ids,(SELECT uniqExact((project_id,event_id)) FROM event_ids) index_ids,(SELECT count() FROM (SELECT DISTINCT project_id,event_id,timestamp,received_at FROM events) WHERE (project_id,event_id,timestamp,received_at) NOT IN (SELECT project_id,event_id,timestamp,received_at FROM event_ids)) missing',
        );
        assert.equal(counts[0]?.missing, 0);
        assert.equal(counts[0]?.ids, counts[0]?.index_ids);
        const identities = await existingEventIdentities(ch, 'qa-online-062', ['legacy', after]);
        assert.equal(identities.get('legacy')?.fingerprint, canonicalFingerprint(JSON.parse(old.payload), old.timestamp));
        assert.ok(identities.has(after));
        const state = await read<{ name: string; engine: string }>(
          "SELECT name,engine FROM system.tables WHERE database=currentDatabase() AND name IN ('event_ids','event_ids_v2','event_ids_mv','event_ids_v2_mv')",
        );
        assert.deepEqual(state.map((t) => t.name).sort(), ['event_ids', 'event_ids_mv']);
        assert.equal(state.find((t) => t.name === 'event_ids')?.engine, 'MergeTree');
        report.push({ interruptedAfterStep: fault < 0 ? null : fault + 1, ...counts[0], state });
        console.log(JSON.stringify(report.at(-1)));
      }
      console.log(JSON.stringify({ database, report }));
    } finally {
      await ch.close();
    }
  },
  180_000,
);

it.skipIf(!run).each([false, true])(
  'covers a pre-attach INSERT SELECT, active through retire=%s',
  async (throughRetire) => {
    const ch = createClickHouseClient({ ...process.env, CLICKHOUSE_DATABASE: database });
    const sql = async (name: string) =>
      (await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))
        .split(';')
        .map((x) => x.trim())
        .filter(Boolean);
    try {
      const ownerRows = await (
        await ch.query({ query: 'SELECT comment FROM system.databases WHERE name=currentDatabase()', format: 'JSONEachRow' })
      ).json<{ comment: string }>();
      assert.equal(ownerRows[0]?.comment, owner);
      assert.equal(
        (await (await ch.query({ query: 'SELECT currentDatabase() db', format: 'JSONEachRow' })).json<{ db: string }>())[0]?.db,
        'logbird_qa_062',
      );
      for (const query of [
        'DROP VIEW IF EXISTS event_ids_v2_mv SYNC',
        'DROP VIEW IF EXISTS event_ids_mv SYNC',
        'DROP TABLE IF EXISTS event_ids_v2 SYNC',
        'DROP TABLE IF EXISTS event_ids SYNC',
      ])
        await ch.command({ query });
      for (const query of await sql('006_event_ids.sql')) await ch.command({ query });
      const queryId = randomUUID(),
        projectId = `qa-late-${randomUUID()}`;
      const writer = ch
        .command({
          query:
            "INSERT INTO events (project_id,event_id,timestamp,received_at,action,payload) SELECT {p:String},concat('late-',toString(number)),now64(3),now64(3),'qa.late',toJSONString(map('id',concat('late-',toString(number)),'action','qa.late')) FROM numbers(10) WHERE sleepEachRow(0.1)=0",
          query_params: { p: projectId },
          query_id: queryId,
        })
        .then(
          () => ({ ok: true, error: undefined }),
          (error) => ({ ok: false, error }),
        );
      let started = false;
      for (let i = 0; i < 100; i++) {
        const rows = await (
          await ch.query({
            query: 'SELECT count() n FROM system.processes WHERE query_id={id:String}',
            query_params: { id: queryId },
            format: 'JSONEachRow',
          })
        ).json<{ n: number }>();
        if (rows[0]?.n) {
          started = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      if (!started) {
        const done = await writer;
        console.log(JSON.stringify({ writer: done }));
      }
      assert.ok(started);
      const statements = await sql('007_event_ids_merge_tree.sql');
      const command = ch.command.bind(ch);
      ch.command = async (params) => {
        const result = await command(params);
        if (params.query === statements[2] && !throughRetire) {
          const result = await writer;
          assert.ok(result.ok, String(result.error));
        }
        return result;
      };
      await migrateEventIdIndex(ch, statements);
      const result = await writer;
      assert.ok(result.ok, String(result.error));
      const rows = await (
        await ch.query({
          query:
            'SELECT count() raw,countIf((project_id,event_id,timestamp,received_at) NOT IN (SELECT project_id,event_id,timestamp,received_at FROM event_ids)) missing FROM events WHERE project_id={p:String}',
          query_params: { p: projectId },
          format: 'JSONEachRow',
        })
      ).json<{ raw: number; missing: number }>();
      assert.deepEqual(rows, [{ raw: 10, missing: 0 }]);
    } finally {
      await ch.close();
    }
  },
  60_000,
);
