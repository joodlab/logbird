import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Opt-in only. Creates exact UUID-owned QA tables in the existing local logbird
// database, plus session-private Memory expectations; touches no application table.
test('cloud receipt checks cover 006 and 007 engines', { skip: process.env.LOGBIRD_CLOUD_RECEIPT_TEST !== '1', timeout: 60_000 }, async (t) => {
  const url = new URL(process.env.CLICKHOUSE_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.ok(['http:', 'https:'].includes(url.protocol));
  assert.equal(process.env.CLICKHOUSE_DATABASE, 'logbird');
  url.username = '';
  url.password = '';
  url.search = '';
  url.searchParams.set('database', 'logbird');
  url.searchParams.set('session_id', `qa_cloud_receipt_${randomUUID()}`);
  url.searchParams.set('default_format', 'JSONEachRow');
  const prefix = `qa_cloud_receipt_${randomUUID().replaceAll('-', '')}`;
  const project = `QA receipt ${randomUUID()}`;
  const auth = `Basic ${Buffer.from(`${process.env.CLICKHOUSE_USER}:${process.env.CLICKHOUSE_PASSWORD}`).toString('base64')}`;
  const owned = [];
  const memory = ['expected_receipts', 'expected_receipt_multiplicity', 'qa_receipt_migrations'];
  const columns = "project_id String,event_id String,received_at DateTime64(3,'UTC'),timestamp DateTime64(3,'UTC')";
  const statements = (file) =>
    readFileSync(new URL(`../docs/${file}`, import.meta.url), 'utf8')
      .replace(/^--.*$/gm, '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean);
  const checks = { '006': statements('cloud-dr-event-ids-006.sql'), '007': statements('cloud-dr-event-ids-007.sql') };
  const growth = statements('cloud-dr-receipt-growth.sql');
  let params = {};

  async function query(sql) {
    const request = new URL(url);
    for (const [name, value] of Object.entries(params)) request.searchParams.set(`param_${name}`, String(value));
    const response = await fetch(request, { method: 'POST', headers: { Authorization: auth }, body: sql, signal: AbortSignal.timeout(15_000) });
    const output = await response.text();
    if (!response.ok) throw new Error(`Local ClickHouse ${response.status}: ${output.slice(0, 500)}`);
    return output.trim();
  }

  async function insert(table, rows) {
    if (rows.length) await query(`INSERT INTO ${table} FORMAT JSONEachRow\n${rows.map((row) => JSON.stringify(row)).join('\n')}`);
  }

  async function create(name, engine) {
    assert.ok(name.startsWith(prefix) && /^[a-z0-9_]+$/.test(name));
    assert.equal(JSON.parse(await query(`EXISTS TABLE logbird.${name}`)).result, 0);
    owned.push(name); // It was absent; cleanup also covers a lost CREATE response.
    await query(
      `CREATE TABLE logbird.${name} (${columns}) ENGINE=${engine} ORDER BY (project_id,event_id${engine === 'MergeTree' ? ',received_at,timestamp' : ''})`,
    );
  }

  function adapt(sql, table) {
    return sql
      .replaceAll('logbird.event_ids', `logbird.${table}`)
      .replaceAll('logbird.migrations', 'qa_receipt_migrations')
      .replaceAll("'event_ids_v2_mv'", `'${table}_v2_mv'`)
      .replaceAll("'event_ids_v2'", `'${table}_v2'`)
      .replaceAll("'event_ids_v3_mv'", `'${table}_v3_mv'`)
      .replaceAll("'event_ids_v3'", `'${table}_v3'`)
      .replaceAll("'event_ids'", `'${table}'`);
  }

  function multiplicity(rows) {
    const counts = new Map();
    for (const row of rows) {
      const key = JSON.stringify(row);
      counts.set(key, { ...row, physical_rows: (counts.get(key)?.physical_rows || 0) + 1 });
    }
    return [...counts.values()];
  }

  async function expectRows(profile, rows, ceiling) {
    for (const name of memory) await query(`TRUNCATE TABLE ${name}`);
    await insert('expected_receipts', rows);
    await insert('expected_receipt_multiplicity', multiplicity(ceiling));
    await insert('qa_receipt_migrations', [{ name: '006_event_ids.sql' }, ...(profile === '007' ? [{ name: '007_event_ids_merge_tree.sql' }] : [])]);
    params = {
      fixture_project: project,
      manifest_receipt_count: rows.length,
      manifest_receipt_id_count: new Set(rows.map((row) => row.event_id)).size,
      manifest_multiplicity_count: multiplicity(ceiling).length,
    };
  }

  async function pass(profile, table) {
    for (const sql of [...checks[profile], ...growth]) assert.equal(await query(adapt(sql, table)), '');
  }

  const old = { project_id: project, event_id: 'fictional-a', received_at: '2026-11-05 00:00:00.000', timestamp: '2026-01-01 00:00:00.000' };
  const survivor = { ...old, received_at: '2026-11-06 00:00:00.000', timestamp: '2026-11-01 00:00:00.000' };
  const tie = { ...survivor, timestamp: '2026-11-02 00:00:00.000' };
  const other = { ...survivor, event_id: 'fictional-b', timestamp: '2026-11-03 00:00:00.000' };
  const replacing = `${prefix}_006`;
  const plain = `${prefix}_007`;

  try {
    t.diagnostic(`ClickHouse ${await query('SELECT version()')}; owned prefix ${prefix}`);
    await query(`CREATE TEMPORARY TABLE expected_receipts (${columns})`);
    await query(`CREATE TEMPORARY TABLE expected_receipt_multiplicity (${columns},physical_rows UInt64)`);
    await query('CREATE TEMPORARY TABLE qa_receipt_migrations (name String)');
    await create(replacing, 'ReplacingMergeTree(received_at)');
    await create(plain, 'MergeTree');

    await t.test('006 uses native FINAL on ReplacingMergeTree with legacy versions', async () => {
      const source = [old, old, survivor, other];
      await insert(`logbird.${replacing}`, source);
      await expectRows('006', [survivor, other], source);
      await pass('006', replacing);
      const logical = (await query(`SELECT * FROM logbird.${replacing} FINAL ORDER BY event_id`)).split('\n').map((row) => JSON.parse(row));
      assert.deepEqual(logical, [survivor, other]);
      t.diagnostic(`006 A physical rows: ${await query(`SELECT count() AS physical_rows FROM logbird.${replacing}`)}; logical IDs: 2`);
    });

    await t.test('006 B/C keep the expected FINAL survivor map and physical ceiling', async () => {
      const after = `${replacing}_bc`;
      await create(after, 'ReplacingMergeTree(received_at)');
      await insert(`logbird.${after}`, [survivor, other]);
      await expectRows('006', [survivor, other], [survivor, other]);
      await pass('006', after);
      await pass('006', after);
    });

    await t.test('007 A accepts overlapping backfill and checks the oldest received tuple', async () => {
      const source = [old, survivor, tie, other, survivor];
      await insert(`logbird.${plain}`, source);
      await expectRows('007', [old, survivor, tie, other], source);
      await pass('007', plain);
      assert.ok(checks['007'].every((sql) => !/\bFINAL\b/.test(sql)));
      const canonical = (await query(`SELECT * FROM logbird.${plain} ORDER BY received_at,timestamp,event_id LIMIT 1 BY event_id`))
        .split('\n')
        .map((row) => JSON.parse(row));
      assert.deepEqual(canonical, [old, other]);
      assert.equal(Number(JSON.parse(await query(`SELECT count() AS n FROM logbird.${plain}`)).n), 5);
      t.diagnostic('007 A: 5 physical rows, 4 distinct tuples, 2 IDs; oldest lookup verified');
    });

    await t.test('007 B/C preserve distinct tuples and choose the oldest surviving tie', async () => {
      // New owned table models post-retention B without queuing a shared mutation.
      const after = `${plain}_bc`;
      await create(after, 'MergeTree');
      const survivingRows = [survivor, tie, other, survivor];
      await insert(`logbird.${after}`, survivingRows);
      await expectRows('007', [survivor, tie, other], survivingRows);
      await pass('007', after); // B
      await pass('007', after); // unchanged C
      assert.equal(Number(JSON.parse(await query(`SELECT count() AS n FROM logbird.${after}`)).n), 4);
      const canonical = (await query(`SELECT * FROM logbird.${after} ORDER BY received_at,timestamp,event_id LIMIT 1 BY event_id`))
        .split('\n')
        .map((row) => JSON.parse(row));
      assert.deepEqual(canonical, [survivor, other]);
      await insert(`logbird.${after}`, [survivor]);
      assert.equal(Number(JSON.parse(await query(`SELECT count() AS n FROM logbird.${after}`)).n), 5);
      for (const sql of checks['007']) assert.equal(await query(adapt(sql, after)), '');
      assert.notEqual(await query(adapt(growth[1], after)), '', 'Physical growth must fail even when logical sets/canonical lookup stay equal');
      t.diagnostic('007 B/C: 4 physical rows, 3 distinct tuples, 2 IDs; extra C copy grows to 5 and is rejected');
    });

    await t.test('007 detects altered canonical lookup and unexpected full tuples', async () => {
      await expectRows('007', [old, survivor, tie, other], [old, survivor, tie, other, survivor]);
      await pass('007', plain);
      const rogue = { ...survivor, received_at: '2026-11-04 00:00:00.000' };
      await insert(`logbird.${plain}`, [rogue]);
      assert.notEqual(await query(adapt(checks['007'].at(-1), plain)), '');
      assert.notEqual(await query(adapt(checks['007'].at(-2), plain)), '');
    });

    await t.test('inventory, engine, empty fixture and manifest mismatches fail closed', async () => {
      await expectRows('006', [survivor, other], [survivor, other]);
      await assert.rejects(query(adapt(checks['007'][0], plain)), /migration inventory mismatch/);
      await assert.rejects(query(adapt(checks['007'][1], replacing)), /engine or interrupted migration mismatch/);
      await assert.rejects(query(adapt(checks['006'][1], plain)), /engine or interrupted migration mismatch/);
      params.fixture_project = 'QA nonexistent receipt project';
      await assert.rejects(query(adapt(checks['006'][2], replacing)), /no fixture receipts/);
      params.fixture_project = project;
      params.manifest_receipt_count = 99;
      await assert.rejects(query(adapt(checks['006'][2], replacing)), /expected receipt manifest count mismatch/);
    });

    await t.test('interrupted 007 staging objects reject an otherwise matching engine', async () => {
      await expectRows('007', [old, survivor, tie, other], [old, survivor, tie, other, survivor]);
      await create(`${plain}_v2`, 'MergeTree');
      await assert.rejects(query(adapt(checks['007'][1], plain)), /engine or interrupted migration mismatch/);
    });
    await t.test('interrupted 008 staging objects reject an otherwise matching engine', async () => {
      const target = `${plain}_008`;
      await create(target, 'MergeTree');
      await create(`${target}_v3`, 'MergeTree');
      await assert.rejects(query(adapt(checks['007'][1], target)), /engine or interrupted migration mismatch/);
    });
  } finally {
    const failures = [];
    for (const name of owned) {
      try {
        await query(`DROP TABLE IF EXISTS logbird.${name} SYNC`);
      } catch {
        failures.push(name);
      }
    }
    for (const name of memory) {
      try {
        await query(`DROP TEMPORARY TABLE IF EXISTS ${name}`);
      } catch {
        failures.push(name);
      }
    }
    assert.deepEqual(failures, [], `Owned table cleanup failed: ${failures.join(', ')}`);
    for (const name of owned) assert.equal(JSON.parse(await query(`EXISTS TABLE logbird.${name}`)).result, 0);
    t.diagnostic(`Cleanup verified: ${owned.length} owned QA tables and ${memory.length} temporary Memory tables removed`);
  }
});
