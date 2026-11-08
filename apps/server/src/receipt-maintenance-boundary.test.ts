import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// REINDEX CONCURRENTLY holds its own session for minutes; it belongs to the worker's hourly job, never to a request.
it('the API server never references worker-only receipt index maintenance', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const scanned: string[] = [];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        scanned.push(entry.name);
        if (/compactIngestReceiptIndex|receipt-index-maintenance/.test(readFileSync(path, 'utf8'))) offenders.push(path);
      }
    }
  };
  walk(root);
  // The scan really covers the request path, so an empty offender list means something.
  expect(scanned).toEqual(expect.arrayContaining(['ingest.ts', 'immutable-ingest.ts', 'app.ts', 'routes.ts']));
  expect(offenders).toEqual([]);
});
