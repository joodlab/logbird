import * as storage from '@logbird/clickhouse';
import { vi } from 'vitest';

/**
 * Test-only storage fault standing in for an unknown future parse trigger. After #153 there is no
 * known public input that survives normalization and fails JSONEachRow parsing. Never install this
 * wrapper in production: it rewrites designated fixture rows immediately before a REAL INSERT.
 */
export function storageFaultBody(body: string) {
  return body.replace(/[^\n]+/g, (line) => {
    const row = JSON.parse(line);
    if (row.attributes?.['metadata.qa91StorageParseFault'] !== 'true') return line;
    return JSON.stringify({ ...row, job_attempt: 'not-a-number' });
  });
}

export function installIngestStorageFault() {
  // Wrap the real insert entrypoint so tests can independently spy on the transport's exec method.
  const insert = storage.insertEvents;
  return vi
    .spyOn(storage, 'insertEvents')
    .mockImplementation((client, rows, lease, body) =>
      insert(client, rows, lease, storageFaultBody(body ?? rows.map((row) => `${JSON.stringify(row)}\n`).join(''))),
    );
}
