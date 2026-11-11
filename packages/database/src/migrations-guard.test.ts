import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Raw-SQL-only indexes that Prisma's schema can't express. `prisma migrate dev` generates a DROP for them on the next
// schema change; such a migration must be edited before it is committed.
const RAW_ONLY_INDEXES = [{ name: 'RetentionRun_failed_ingest_repair', createdIn: '20261111120000_retention_run_failed_ingest_repair' }];
const dir = fileURLToPath(new URL('../prisma/migrations', import.meta.url));
const migrations = readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

it.each(RAW_ONLY_INDEXES)('keeps the raw-SQL-only index $name: created once and never dropped later', ({ name, createdIn }) => {
  expect(migrations).toContain(createdIn);
  const sql = (migration: string) => readFileSync(join(dir, migration, 'migration.sql'), 'utf8');
  expect(sql(createdIn)).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS "${name}"[\\s\\S]*WHERE`));
  for (const migration of migrations.filter((m) => m > createdIn))
    expect(sql(migration), `${migration} must not drop ${name}`).not.toMatch(new RegExp(`DROP INDEX[^;]*"${name}"`, 'i'));
});
