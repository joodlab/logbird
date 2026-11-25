import { readFileSync } from 'node:fs';
import { EVENT_LIMITS, facetQuerySchema, REQUEST_LIMITS, searchQuerySchema } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { COUNT_CAP } from './queries';

// docs/limits.md states each limit; this fails when a documented number drifts from the constant the code enforces.
const doc = readFileSync(new URL('../../../docs/limits.md', import.meta.url), 'utf8');
/** The value cell of the table row whose first cell is `label`. */
function value(label: string) {
  const row = doc.split('\n').find((line) => line.startsWith(`| ${label} |`));
  if (!row) throw new Error(`docs/limits.md has no row "${label}"`);
  return row.split('|')[2]?.trim() ?? '';
}
const first = (label: string) => Number(value(label).match(/^\d+/)?.[0]);

it('documents every per-event limit with the number the normalizer uses', () => {
  expect(first('Targets indexed')).toBe(EVENT_LIMITS.targets);
  expect(first('Changes indexed')).toBe(EVENT_LIMITS.changes);
  expect(first('Change field name')).toBe(EVENT_LIMITS.changeField);
  expect(first('Attributes indexed')).toBe(EVENT_LIMITS.attributes);
  expect(first('Attribute value')).toBe(EVENT_LIMITS.attributeBytes);
  expect(first('Attribute depth')).toBe(EVENT_LIMITS.attributeDepth);
  expect(first('Description')).toBe(EVENT_LIMITS.description);
  expect(first('Event size')).toBe(EVENT_LIMITS.payloadBytes);
});

it('documents every per-request limit with the number the server enforces', () => {
  expect(first('Ingest batch')).toBe(REQUEST_LIMITS.ingestEvents);
  expect(first('Ingest body')).toBe(REQUEST_LIMITS.ingestBodyBytes);
  expect(first('Search page (`limit`)')).toBe(REQUEST_LIMITS.pageSize);
  expect(first('Facet values (`limit`)')).toBe(REQUEST_LIMITS.facetValues);
  expect(first('Facet second level (`byLimit`)')).toBe(REQUEST_LIMITS.facetGroups);
  expect(first('Query (`q`)')).toBe(REQUEST_LIMITS.queryBytes);
  expect(first('Search count (`total`)')).toBe(REQUEST_LIMITS.countCap);
  expect(first('Detail parent walk')).toBe(REQUEST_LIMITS.parentDepth);
  // The constants are the bounds the read schemas and the count apply.
  const accepts = (schema: typeof searchQuerySchema | typeof facetQuerySchema, input: Record<string, unknown>) => schema.safeParse(input).success;
  expect(accepts(searchQuerySchema, { limit: REQUEST_LIMITS.pageSize })).toBe(true);
  expect(accepts(searchQuerySchema, { limit: REQUEST_LIMITS.pageSize + 1 })).toBe(false);
  expect(accepts(facetQuerySchema, { field: 'action', limit: REQUEST_LIMITS.facetValues })).toBe(true);
  expect(accepts(facetQuerySchema, { field: 'action', limit: REQUEST_LIMITS.facetValues + 1 })).toBe(false);
  expect(accepts(facetQuerySchema, { field: 'action', byLimit: REQUEST_LIMITS.facetGroups })).toBe(true);
  expect(accepts(facetQuerySchema, { field: 'action', byLimit: REQUEST_LIMITS.facetGroups + 1 })).toBe(false);
  expect(accepts(searchQuerySchema, { q: 'x'.repeat(REQUEST_LIMITS.queryBytes + 1) })).toBe(false);
  expect(COUNT_CAP).toBe(REQUEST_LIMITS.countCap);
});
