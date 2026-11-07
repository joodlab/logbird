import { expect, it } from 'vitest';
import { CSV_COLUMNS, csvCell, csvEvent } from './export';
import { normalizeEvent } from './normalize';
import { toEvent } from './queries';

it.each(['=1+1', '+1', '-1', '@SUM(1)', '\t=1', '\r=1', '\n=1'])('neutralizes formula-leading cell %j', (value) =>
  expect(csvCell(value)).toBe(`"'${value}"`),
);
it('escapes delimiters, double quotes and embedded newlines without changing ordinary values', () => {
  expect(csvCell('plain,"quoted"\nnext')).toBe('"plain,""quoted""\nnext"');
  expect(csvCell('')).toBe('""');
});
it('keeps attribution, before/after values and context in a stable flat CSV schema', () => {
  const r = normalizeEvent(
    {
      action: 'record.updated',
      actor: { id: 'effective', name: 'Person' },
      impersonator: { id: 'support', name: 'Support' },
      executor: { type: 'worker', id: 'worker', jobId: 'job', attempt: 2 },
      targets: [{ type: 'record', id: 'r' }],
      changes: [{ field: 'state', before: 'old', after: 'new' }],
      context: { ip: '203.0.113.1', requestId: 'req' },
    },
    { projectId: 'p', receivedAt: new Date() },
  );
  if (!r.ok) throw new Error(r.reason);
  const event = toEvent(r.row);
  // Parse RFC4180 cells (including escaped quotes) independently of the exporter.
  const values = [...csvEvent(event).matchAll(/"((?:[^"]|"")*)"(?:,|\n$)/g)].map((m) => (m[1] ?? '').replaceAll('""', '"'));
  const cells = Object.fromEntries(CSV_COLUMNS.map((key, i) => [key, values[i]]));
  expect(values).toHaveLength(CSV_COLUMNS.length);
  expect(cells).toMatchObject({ actor_id: 'effective', impersonator_id: 'support', executor_id: 'worker', job_id: 'job', job_attempt: '2' });
  expect(JSON.parse(cells.changes ?? '')).toEqual([{ field: 'state', before: 'old', after: 'new' }]);
  expect(JSON.parse(cells.targets ?? '')).toEqual(event.targets);
  expect(JSON.parse(cells.context ?? '')).toMatchObject({ ip: '203.0.113.1', requestId: 'req' });
});
