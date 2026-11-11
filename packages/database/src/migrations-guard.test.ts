import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Raw-SQL-only indexes that Prisma's schema can't express. `prisma migrate dev` generates a DROP for them on the next
// schema change; such a migration must be edited before it is committed. Every migration is checked, not only later
// names: a backdated migration still runs on installations that already applied the creator.
const RAW_ONLY_INDEXES = [{ name: 'RetentionRun_failed_ingest_repair', createdIn: '20261111120000_retention_run_failed_ingest_repair' }];
const dir = fileURLToPath(new URL('../prisma/migrations', import.meta.url));
const migrations = readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sql = (migration: string) => readFileSync(join(dir, migration, 'migration.sql'), 'utf8');
const dropsIndex = (text: string, name: string) => new RegExp(`DROP\\s+INDEX[^;]*"${name}"`, 'i').test(text);

it.each(RAW_ONLY_INDEXES)('keeps the raw-SQL-only index $name: created once and never dropped by any migration', ({ name, createdIn }) => {
  expect(migrations).toContain(createdIn);
  expect(sql(createdIn)).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS "${name}"[\\s\\S]*WHERE`));
  for (const migration of migrations.filter((m) => m !== createdIn))
    expect(dropsIndex(sql(migration), name), `${migration} drops ${name}`).toBe(false);
});

it('detects a drop in a backdated migration and the forms Prisma generates', () => {
  const name = 'RetentionRun_failed_ingest_repair';
  expect(dropsIndex(`-- DropIndex\nDROP INDEX "${name}";`, name)).toBe(true);
  expect(dropsIndex(`DROP INDEX IF EXISTS "public"."${name}";`, name)).toBe(true);
  expect(dropsIndex(`drop index concurrently "${name}";`, name)).toBe(true);
  expect(dropsIndex(`CREATE INDEX "${name}_other" ON "RetentionRun" ("projectId");`, name)).toBe(false);
});
