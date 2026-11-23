import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every ClickHouse client is built by client.ts, so every reader gets `apply_mutations_on_fly` (the hourly retention run
// creates DELETEs without waiting for them, #268) and the shared limits. Nothing else may import a value from
// @clickhouse/client; a new exception has to be listed here with its reason.
const root = fileURLToPath(new URL('../../..', import.meta.url));
const ALLOWED: Record<string, string> = {
  'packages/clickhouse/src/client.ts': 'the one factory every client comes from',
  'apps/server/src/test-services.ts': 'test setup: wraps the factory to raise the socket timeout, passing every setting through',
  'apps/server/src/export-parity.integration.test.ts': 'test: fault injection with its own short-lived client',
  'apps/server/src/project-delete-race.integration.test.ts': 'test: fault injection with its own short-lived client',
  'packages/clickhouse/src/delete-mutation-race.integration.test.ts': 'test: a client whose request deliberately times out',
  'packages/clickhouse/src/event-id-dense.integration.test.ts': 'test: a client whose request deliberately times out',
  'apps/worker/src/webhook-delivery.integration.test.ts': 'test: a client with a fixed session time zone, to prove delivery times are UTC',
  'apps/worker/src/webhook-discovery.integration.test.ts': 'test: clients with deliberately small read limits, and an unreachable one',
  'apps/worker/src/webhook-resilience.integration.test.ts': 'test: clients with deliberately small read limits',
};
const SKIP = new Set(['node_modules', 'dist', '.output', '.nitro', 'generated', '.turbo', 'coverage', '.tmp', '.git', 'experiments']);

function sources(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

describe('ClickHouse client boundary', () => {
  it('builds every ClickHouse client in client.ts (or a listed test harness)', () => {
    const offenders: string[] = [];
    for (const base of ['apps', 'packages', 'scripts']) {
      for (const file of sources(join(root, base))) {
        const text = readFileSync(file, 'utf8');
        // A value import (not `import type`) or a require of the client package.
        const valueImport =
          /import\s+(?!type\b)[^;]*?from\s+['"]@clickhouse\/client['"]/.test(text) || /require\(\s*['"]@clickhouse\/client['"]\s*\)/.test(text);
        if (!valueImport) continue;
        const path = relative(root, file).split(sep).join('/');
        if (!(path in ALLOWED)) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('applies pending DELETE mutations on every read the factory builds', () => {
    const client = readFileSync(join(root, 'packages/clickhouse/src/client.ts'), 'utf8');
    expect(client).toMatch(/apply_mutations_on_fly: 1/);
    // ...and every mutation it creates is applicable on the fly (no now() or subquery left in a pending predicate).
    expect(client).toMatch(/mutations_execute_nondeterministic_on_initiator: 1/);
    expect(client).toMatch(/mutations_execute_subqueries_on_initiator: 1/);
  });
});
