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

// #138 rollback safety: the ApiKey roll fence (trigger + function) is raw SQL Prisma doesn't model. No later migration
// may drop or replace it with a weaker body.
const ROLL_FENCE = { createdIn: '20261122110000_api_key_roll_fence', trigger: 'ApiKey_roll_fence', fn: 'logbird_api_key_roll_fence' };
// Names may be quoted or not, and schema-qualified ("public"."x" or public.x).
const name = (n: string) => `(?:"?\\w+"?\\s*\\.\\s*)?"?${n}"?`;
const dropsFence = (text: string) =>
  new RegExp(`DROP\\s+(?:TRIGGER[^;]*${name(ROLL_FENCE.trigger)}|FUNCTION[^;]*${name(ROLL_FENCE.fn)})`, 'i').test(text) ||
  new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+${name(ROLL_FENCE.trigger)}`, 'i').test(text) ||
  new RegExp(`(?:CREATE\\s+OR\\s+REPLACE|ALTER)\\s+FUNCTION\\s+${name(ROLL_FENCE.fn)}`, 'i').test(text) ||
  new RegExp(`ALTER\\s+TRIGGER\\s+${name(ROLL_FENCE.trigger)}`, 'i').test(text) ||
  /ALTER\s+TABLE[^;]*"?ApiKey"?[^;]*DISABLE\s+TRIGGER/i.test(text);

it('keeps the ApiKey roll fence: created once, never dropped, replaced or disabled by a later migration', () => {
  expect(migrations).toContain(ROLL_FENCE.createdIn);
  const created = sql(ROLL_FENCE.createdIn);
  expect(created).toMatch(new RegExp(`CREATE TRIGGER "${ROLL_FENCE.trigger}" BEFORE INSERT ON "ApiKey"`));
  expect(created).toMatch(/IS DISTINCT FROM NEW\."scope"/);
  expect(created).toMatch(/replaced\."expiresAt" IS NOT NULL AND NEW\."expiresAt" IS NULL/);
  for (const migration of migrations.filter((m) => m !== ROLL_FENCE.createdIn)) expect(dropsFence(sql(migration)), migration).toBe(false);
  for (const statement of [
    `DROP TRIGGER IF EXISTS "${ROLL_FENCE.trigger}" ON "ApiKey";`,
    `drop function "${ROLL_FENCE.fn}"();`,
    `DROP FUNCTION public.${ROLL_FENCE.fn}() CASCADE;`,
    `DROP FUNCTION "public"."${ROLL_FENCE.fn}"();`,
    `CREATE OR REPLACE FUNCTION public.${ROLL_FENCE.fn}() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;`,
    `CREATE OR REPLACE TRIGGER "${ROLL_FENCE.trigger}" BEFORE UPDATE ON "ApiKey" FOR EACH ROW EXECUTE FUNCTION f();`,
    `ALTER TRIGGER "${ROLL_FENCE.trigger}" ON "ApiKey" RENAME TO x;`,
    `ALTER TABLE "ApiKey" DISABLE TRIGGER ALL;`,
    `ALTER TABLE public."ApiKey" DISABLE TRIGGER "${ROLL_FENCE.trigger}";`,
  ])
    expect(dropsFence(statement), statement).toBe(true);
  expect(dropsFence('CREATE INDEX "ApiKey_projectId_idx" ON "ApiKey" ("projectId");')).toBe(false);
});
