import { readFileSync } from 'node:fs';
import { parseJsonExact } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { canonicalFingerprint, eventFingerprint, retryFingerprint } from './identity';
import { normalizeEvent } from './normalize';

const ctx = { projectId: 'fictional-exact', receivedAt: new Date('2026-11-22T12:00:00Z') };
const wire = (text: string) => parseJsonExact(text);
const normalize = (input: unknown) => {
  const result = normalizeEvent(input, ctx);
  if (!result.ok) throw new Error(result.reason);
  return result;
};

it('stores and indexes numbers a double cannot hold with their exact digits', () => {
  const { row } = normalize(
    wire(
      '{"id":"e1","action":"order.paid","metadata":{"orderId":9007199254740993,"snowflake":1234567890123456789,"rate":0.12345678901234567890123,"list":[12345678901234567891]},"changes":[{"field":"balance","before":12345678901234567891,"after":0.1}]}',
    ),
  );
  expect(row.payload).toBe(
    '{"id":"e1","action":"order.paid","metadata":{"orderId":9007199254740993,"snowflake":1234567890123456789,"rate":0.12345678901234567890123,"list":[12345678901234567891]},"changes":[{"field":"balance","before":12345678901234567891,"after":0.1}]}',
  );
  expect(row.attributes).toEqual({
    'metadata.orderId': '9007199254740993',
    'metadata.snowflake': '1234567890123456789',
    'metadata.rate': '0.12345678901234567890123',
    'metadata.list': '[12345678901234567891]',
  });
  expect(row.changes_before).toEqual(['12345678901234567891']);
  expect(row.changes_after).toEqual(['0.1']);
});

it('indexes numeric entity ids by their decimal text instead of dropping them', () => {
  const { row } = normalize(
    wire(
      '{"action":"page.updated","actor":{"type":"user","id":42},"tenant":{"id":7,"name":"Seven"},"executor":{"id":3,"jobId":1234567890123456789,"attempt":2},"impersonator":{"id":5},"targets":[{"type":"page","id":12},{"type":"site","id":9007199254740993}],"context":{"operationId":99}}',
    ),
  );
  expect([row.actor_id, row.tenant_id, row.executor_id, row.job_id, row.impersonator_id, row.operation_id]).toEqual([
    '42',
    '7',
    '3',
    '1234567890123456789',
    '5',
    '99',
  ]);
  expect(row.target_ids).toEqual(['12', '9007199254740993']);
  expect(row.job_attempt).toBe(2);
});

it('still gives a numeric event id a fresh id and a warning, also for 64-bit ids', () => {
  for (const text of ['{"id":42,"action":"x"}', '{"id":1234567890123456789,"action":"x"}']) {
    const result = normalize(wire(text));
    expect(result.row.event_id).not.toMatch(/^\d+$/);
    expect(result.warning).toContain('Numeric id');
  }
});

it('resolves sub-millisecond epoch digits as before', () => {
  const { row } = normalize(wire('{"action":"x","occurredAt":1795325485138.12345678901234}'));
  expect(row.timestamp).toBe(new Date(1_795_325_485_138).toISOString());
});

it('caps a huge attempt like JSON.parse did', () => {
  expect(normalize(wire('{"action":"x","executor":{"attempt":1e400}}')).row.job_attempt).toBe(65_535);
});

it('keeps identity unchanged for every frozen golden vector parsed from the wire', () => {
  const goldens = JSON.parse(readFileSync(new URL('./fixtures/identity-goldens.json', import.meta.url), 'utf8')) as {
    cases: { input: Record<string, unknown>; row: { timestamp: string }; v1: string }[];
  };
  expect(goldens.cases.length).toBeGreaterThan(0);
  for (const vector of goldens.cases) expect(canonicalFingerprint(wire(JSON.stringify(vector.input)), vector.row.timestamp)).toBe(vector.v1);
});

it('keeps identity unchanged for ordinary numbers, whatever their spelling', () => {
  const plain = canonicalFingerprint(JSON.parse('{"action":"x","n":[1,2.5,19.9,1000]}'), '2026-11-22T12:00:00.000Z');
  expect(canonicalFingerprint(wire('{"action":"x","n":[1,2.5,19.90,1e3]}'), '2026-11-22T12:00:00.000Z')).toBe(plain);
});

it('distinguishes exact digits from their rounded double and from a lookalike object', () => {
  const at = '2026-11-22T12:00:00.000Z';
  const exact = canonicalFingerprint(wire('{"action":"x","n":1234567890123456789}'), at);
  expect(canonicalFingerprint(wire('{"action":"x","n":1234567890123456800}'), at)).not.toBe(exact);
  expect(canonicalFingerprint({ action: 'x', n: { rawJSON: '1234567890123456789' } }, at)).not.toBe(exact);
  expect(canonicalFingerprint(wire('{"n":1234567890123456789,"action":"x"}'), at)).toBe(exact);
});

it('computes the stored fingerprint and the retry fingerprint from the same exact digits', () => {
  const input = wire('{"id":"e2","action":"x","metadata":{"snowflake":1234567890123456789}}');
  const { row } = normalize(input);
  expect(retryFingerprint(input, ctx.projectId, ctx.receivedAt, 'e2')).toBe(eventFingerprint(row));
});
