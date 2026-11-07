import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { rollupSql } from './rollup-sql';

it('ships the canonical rollup definitions inside the runtime module', async () => {
  const migration = await readFile(new URL('../migrations/002_rollups.sql', import.meta.url), 'utf8');
  expect(rollupSql.trim()).toBe(migration.replaceAll('\r\n', '\n').trim());
});
