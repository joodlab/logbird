import { readFileSync } from 'node:fs';
import { EVENT_LIMITS, EXACT_NUMBER_MAX_DEPTH, facetQuerySchema, parseQueryExpression, REQUEST_LIMITS, searchQuerySchema } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { COUNT_CAP, timeRange } from './queries';
import { compileQuery } from './query';
import { OCCURRED_AT_FUTURE_DAYS, OCCURRED_AT_PAST_DAYS } from './timestamp';

// docs/limits.md states each limit; this fails when a documented number drifts from the code that enforces it.
const doc = readFileSync(new URL('../../../docs/limits.md', import.meta.url), 'utf8');
/** The value cell of the table row whose first cell is `label`. */
function value(label: string) {
  const row = doc.split('\n').find((line) => line.startsWith(`| ${label} |`));
  if (!row) throw new Error(`docs/limits.md has no row "${label}"`);
  return row.split('|')[2]?.trim() ?? '';
}
const numbers = (label: string) => [...value(label).matchAll(/\d+/g)].map((m) => Number(m[0]));
const first = (label: string) => numbers(label)[0];
/** "5242880 bytes (5 MiB)": the bytes and the binary unit agree. */
function bytes(label: string) {
  const cell = value(label);
  const n = Number(cell.match(/^(\d+) bytes/)?.[1]);
  const unit = cell.match(/\((\d+) (KiB|MiB)\)/);
  if (!unit) throw new Error(`"${label}" names no KiB/MiB size`);
  expect(n).toBe(Number(unit[1]) * (unit[2] === 'MiB' ? 1024 * 1024 : 1024));
  return n;
}
const defaultOf = (label: string) => Number(value(label).match(/\(default (\d+)\)/)?.[1]);

it('documents every per-event limit with the number the normalizer uses', () => {
  expect(bytes('Event size')).toBe(EVENT_LIMITS.payloadBytes);
  expect(first('Number depth')).toBe(EXACT_NUMBER_MAX_DEPTH);
  expect(first('Targets indexed')).toBe(EVENT_LIMITS.targets);
  expect(first('Changes indexed')).toBe(EVENT_LIMITS.changes);
  expect(first('Change field name')).toBe(EVENT_LIMITS.changeField);
  expect(first('Attributes indexed')).toBe(EVENT_LIMITS.attributes);
  expect(first('Attribute value')).toBe(EVENT_LIMITS.attributeBytes);
  expect(first('Attribute depth')).toBe(EVENT_LIMITS.attributeDepth);
  expect(first('Description')).toBe(EVENT_LIMITS.description);
  expect(numbers('occurredAt')).toEqual([OCCURRED_AT_PAST_DAYS, OCCURRED_AT_FUTURE_DAYS]);
});

it('documents every per-request limit, its default and its unit, with what the server enforces', () => {
  expect(first('Ingest batch')).toBe(REQUEST_LIMITS.ingestEvents);
  expect(bytes('Ingest body')).toBe(REQUEST_LIMITS.ingestBodyBytes);
  expect(bytes('Viewer-token request body')).toBe(REQUEST_LIMITS.viewerTokenBodyBytes);
  expect(first('Query size (`q`)')).toBe(REQUEST_LIMITS.queryBytes);
  expect(first('Query terms (`q`)')).toBe(REQUEST_LIMITS.queryTerms);
  expect(first('Query nesting (`q`)')).toBe(REQUEST_LIMITS.queryDepth);
  expect(first('Search count (`total`)')).toBe(REQUEST_LIMITS.countCap);
  expect(first('Detail parent walk')).toBe(REQUEST_LIMITS.parentDepth);
  expect(COUNT_CAP).toBe(REQUEST_LIMITS.countCap);

  // Page sizes: the bound and the default, from the schemas the routes validate with.
  const search = (input: Record<string, unknown>) => searchQuerySchema.safeParse(input);
  const facet = (input: Record<string, unknown>) => facetQuerySchema.safeParse({ field: 'action', ...input });
  expect(first('Search page (`limit`)')).toBe(REQUEST_LIMITS.pageSize);
  expect(search({ limit: REQUEST_LIMITS.pageSize }).success && !search({ limit: REQUEST_LIMITS.pageSize + 1 }).success).toBe(true);
  expect(defaultOf('Search page (`limit`)')).toBe(search({}).data?.limit);
  expect(first('Facet values (`limit`)')).toBe(REQUEST_LIMITS.facetValues);
  expect(facet({ limit: REQUEST_LIMITS.facetValues }).success && !facet({ limit: REQUEST_LIMITS.facetValues + 1 }).success).toBe(true);
  expect(defaultOf('Facet values (`limit`)')).toBe(facet({}).data?.limit);
  expect(first('Facet second level (`byLimit`)')).toBe(REQUEST_LIMITS.facetGroups);
  expect(facet({ byLimit: REQUEST_LIMITS.facetGroups }).success && !facet({ byLimit: REQUEST_LIMITS.facetGroups + 1 }).success).toBe(true);
  expect(defaultOf('Facet second level (`byLimit`)')).toBe(facet({}).data?.byLimit);

  // Query terms and nesting, by behaviour.
  const terms = (n: number) => Array.from({ length: n }, (_, i) => `action:a${i}`).join(' ');
  expect(() => compileQuery(terms(REQUEST_LIMITS.queryTerms))).not.toThrow();
  expect(() => compileQuery(terms(REQUEST_LIMITS.queryTerms + 1))).toThrow(/terms/);
  const nested = (n: number) => `${'('.repeat(n)}action:a${')'.repeat(n)}`;
  expect(() => parseQueryExpression(nested(REQUEST_LIMITS.queryDepth))).not.toThrow();
  expect(() => parseQueryExpression(nested(REQUEST_LIMITS.queryDepth + 1))).toThrow(/nesting/);

  // The default window, by behaviour.
  const to = '2026-11-25T12:00:00.000Z';
  const window = timeRange({ to });
  expect(Number(first('Time window of search, facets and export without `from`')) * 3_600_000).toBe(Date.parse(window.to) - Date.parse(window.from));
});
