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

it('hashes equivalent spellings of an exact number the same, and keeps the sent spelling in the payload', () => {
  const at = '2026-11-22T12:00:00.000Z';
  const a = canonicalFingerprint(wire('{"action":"x","n":9007199254740993}'), at);
  expect(canonicalFingerprint(wire('{"action":"x","n":9007199254740993.0}'), at)).toBe(a);
  expect(canonicalFingerprint(wire('{"action":"x","n":9.007199254740993e15}'), at)).toBe(a);
  expect(normalize(wire('{"action":"x","n":9007199254740993.0}')).row.payload).toBe('{"action":"x","n":9007199254740993.0}');
});

it('never matches a different number at double precision, in either order', () => {
  const at = '2026-11-22T12:00:00.000Z';
  const plain = canonicalFingerprint(wire('{"id":"e","action":"x","n":9007199254740992}'), at);
  const exact = canonicalFingerprint(wire('{"id":"e","action":"x","n":9007199254740993}'), at);
  expect(plain).not.toBe(exact);
  expect(retryFingerprint(wire('{"id":"e","action":"x","n":9007199254740993}'), ctx.projectId, ctx.receivedAt, 'e', plain, new Date(at))).toBe(exact);
  expect(retryFingerprint(wire('{"id":"e","action":"x","n":9007199254740992}'), ctx.projectId, ctx.receivedAt, 'e', exact, new Date(at))).toBe(plain);
});

it('keeps a number with a huge exponent as sent, without big arithmetic', () => {
  const token = `1e-${'9'.repeat(20)}`;
  const { row } = normalize(wire(`{"action":"x","metadata":{"tiny":${token}}}`));
  expect(row.payload).toContain(`"tiny":${token}`);
});

it('indexes numbers only in identifier columns and counts numeric ids in conformance', () => {
  const { row } = normalize(
    wire('{"action":"x","outcome":1,"severity":2,"environment":3,"description":4,"actor":{"id":0,"name":5},"schemaVersion":2}'),
  );
  expect([row.outcome, row.severity, row.environment, row.description, row.actor_name]).toEqual(['success', 'info', 'production', '', '']);
  expect([row.actor_id, row.schema_version]).toEqual(['0', '2']);
  const withZero = normalize(wire('{"action":"x","actor":{"id":0}}')).row.conformance;
  const without = normalize(wire('{"action":"x"}')).row.conformance;
  expect(withZero).toBeGreaterThan(without);
});

it('stores a numeric id as the plain decimal of its exact value, one spelling per value', () => {
  for (const spelling of ['42', '42.0', '4.2e1'])
    expect(normalize(wire(`{"action":"x","tenant":{"id":${spelling}},"targets":[{"type":"page","id":${spelling}}]}`)).row).toMatchObject({
      tenant_id: '42',
      target_ids: ['42'],
    });
  expect(normalize(wire('{"action":"x","actor":{"id":9007199254740993.0}}')).row.actor_id).toBe('9007199254740993');
  // Strings stay exactly as sent.
  expect(normalize(wire('{"action":"x","tenant":{"id":"42.0"}}')).row.tenant_id).toBe('42.0');
});

it('never truncates or empties a long numeric id: it keeps a unique scientific spelling', () => {
  const ids = (n: string) => normalize(wire(`{"action":"x","actor":{"id":${n}},"targets":[{"type":"t","id":${n}}]}`)).row;
  expect(ids('1e256')).toMatchObject({ actor_id: '1e256', target_ids: ['1e256'] });
  expect(ids('1e257').actor_id).toBe('1e257');
  expect(ids('1e100').actor_id).toBe(`1${'0'.repeat(100)}`);
  expect(ids(`1e${'9'.repeat(20)}`).actor_id).toBe(`1e${'9'.repeat(20)}`);
});
