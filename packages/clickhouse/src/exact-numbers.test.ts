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

it('never truncates a long numeric id: plain if it fits, else unique scientific, else not indexed', () => {
  const ids = (n: string) => normalize(wire(`{"action":"x","actor":{"id":${n}},"targets":[{"type":"order","id":${n}}]}`)).row;
  // Plain adds at most 32 zeros to the digits; past that the unique scientific spelling, whatever the sent spelling.
  expect(ids('1e32')).toMatchObject({ actor_id: `1${'0'.repeat(32)}`, target_ids: [`1${'0'.repeat(32)}`] });
  expect(ids(`1${'0'.repeat(32)}`).actor_id).toBe(`1${'0'.repeat(32)}`);
  expect(ids('1e33')).toMatchObject({ actor_id: '1e33', target_ids: ['1e33'] });
  expect(ids(`1${'0'.repeat(33)}`).actor_id).toBe('1e33');
  expect(ids('1e256')).toMatchObject({ actor_id: '1e256', target_ids: ['1e256'] });
  expect(ids('2e256').target_ids).toEqual(['2e256']);
  // Indexed numbers are strictly shorter than the column: a longer string id truncated to 256 can never equal one.
  expect(ids('1'.repeat(255)).actor_id).toBe('1'.repeat(255));
  expect(ids('1'.repeat(256)).actor_id).toBe('');
  expect(normalize(wire(`{"action":"x","actor":{"id":"${'1'.repeat(300)}"}}`)).row.actor_id).toBe('1'.repeat(256));
  // Two 257-significant-digit ids that share their first 256 digits must not merge: neither is indexed, and such a
  // target leaves the record columns entirely (no shared `order:` record).
  expect([ids(`${'1'.repeat(256)}1`).actor_id, ids(`${'1'.repeat(256)}2`).actor_id]).toEqual(['', '']);
  expect(ids(`${'1'.repeat(256)}1`)).toMatchObject({ target_types: [], target_ids: [], target_names: [] });
  const mixed = normalize(
    wire(`{"action":"x","targets":[{"type":"page","id":7},{"type":"order","id":${'1'.repeat(257)}},{"type":"site","id":"s"}]}`),
  ).row;
  expect([mixed.target_types, mixed.target_ids]).toEqual([
    ['page', 'site'],
    ['7', 's'],
  ]);
});

it('stores long numbers as doubles with a warning only for events nested deeper than the exactness bound', () => {
  const deep = `{"action":"x","metadata":{"n":12345678901234567891,"deep":${'['.repeat(1100)}1${']'.repeat(1100)}}}`;
  const result = normalize(wire(deep));
  expect(result.warning).toContain('Nested deeper than 1000 levels');
  expect(result.row.attributes['metadata.n']).toBe('12345678901234567000');
  const shallow = normalize(wire('{"action":"x","metadata":{"n":12345678901234567891,"deep":[[[1]]]}}'));
  expect(shallow.warning).toBeNull();
  expect(shallow.row.attributes['metadata.n']).toBe('12345678901234567891');
});

it('keeps the deep-rounding warning when re-normalizing, and survives cyclic caller objects', () => {
  expect(normalize(wire('{"action":"x"}')).warning).toBeNull();
  expect(
    normalizeEvent({ action: 'x' }, { ...ctx, numbersRounded: true }).ok && normalizeEvent({ action: 'x' }, { ...ctx, numbersRounded: true }),
  ).toMatchObject({
    warning: expect.stringContaining('Nested deeper than 1000 levels'),
  });
  const cyclic: Record<string, unknown> = { action: 'x' };
  cyclic.self = cyclic;
  expect(normalizeEvent(cyclic, ctx)).toMatchObject({ ok: false, reason: 'event must be JSON serializable' });
});

it('indexes an exact numeric attribute whole or not at all, never as a prefix', () => {
  const huge = `1${'2'.repeat(2048)}`; // 2,049 significant digits
  const { row } = normalize(wire(`{"action":"x","metadata":{"huge":${huge},"sparse":1e3000,"small":12345678901234567891}}`));
  expect(row.attributes['metadata.huge']).toBeUndefined();
  expect(row.attributes['metadata.sparse']).toBe('1e3000');
  expect(row.attributes['metadata.small']).toBe('12345678901234567891');
  expect(row.payload).toContain(`"huge":${huge}`);
});

it('indexes ordinary numeric attributes as plain decimals, legacy columns unchanged', () => {
  const input = wire('{"action":"x","metadata":{"rate":0.0000001,"big":1e21,"n":42,"f":19.9}}');
  expect(normalize(input).row.attributes).toMatchObject({
    'metadata.rate': '0.0000001',
    'metadata.big': '1000000000000000000000',
    'metadata.n': '42',
    'metadata.f': '19.9',
  });
  const legacy = normalizeEvent(input, { ...ctx, legacyColumns: true });
  expect(legacy.ok && legacy.row.attributes).toMatchObject({ 'metadata.rate': '1e-7', 'metadata.big': '1e+21' });
});

it('indexes a rejected numeric timestamp whole, so two long values never match each other', () => {
  const a = normalize(wire(`{"action":"x","occurredAt":${'1'.repeat(200)}1}`)).row.attributes['logbird.occurredAt.rejected'];
  const b = normalize(wire(`{"action":"x","occurredAt":${'1'.repeat(200)}2}`)).row.attributes['logbird.occurredAt.rejected'];
  expect(a).toBe(`${'1'.repeat(200)}1`);
  expect(b).toBe(`${'1'.repeat(200)}2`);
  // Same cap as a rejected string: a 256-digit number is not indexed, so it never equals a truncated long string.
  expect(normalize(wire(`{"action":"x","occurredAt":${'1'.repeat(256)}}`)).row.attributes['logbird.occurredAt.rejected']).toBeUndefined();
  expect(normalize(wire(`{"action":"x","occurredAt":"${'1'.repeat(300)}"}`)).row.attributes['logbird.occurredAt.rejected']).toBe(
    '1'.repeat(256),
  );
  expect(normalize(wire('{"action":"x","occurredAt":"yesterday"}')).row.attributes['logbird.occurredAt.rejected']).toBe('yesterday');
});

it('never leaves a caller-supplied rejected-timestamp attribute when the number cannot be indexed', () => {
  const huge = `1${'2'.repeat(2048)}`;
  const { row } = normalize(wire(`{"action":"x","logbird":{"occurredAt":{"rejected":"42"}},"occurredAt":${huge}}`));
  expect(row.attributes['logbird.occurredAt.rejected']).toBeUndefined();
  const small = normalize(wire('{"action":"x","logbird":{"occurredAt":{"rejected":"42"}},"occurredAt":"yesterday"}')).row;
  expect(small.attributes['logbird.occurredAt.rejected']).toBe('yesterday');
});

it('compares pre-v1 claims as the old parser read them: a JSON number never matches a stored string of digits it lost', () => {
  const legacy = (text: string, parse: (t: string) => unknown = wire) =>
    retryFingerprint(parse(text), ctx.projectId, ctx.receivedAt, 'e1', 'legacy-claim');
  const number = '{"id":"e1","action":"x","metadata":{"n":9007199254740993}}';
  // The retry reads exactly as JSON.parse did before exact numbers.
  expect(legacy(number)).toBe(legacy(number, JSON.parse));
  // The original claim stored the string "9007199254740993"; the old parser read the number as …992 and rejected it.
  expect(legacy(number)).not.toBe(legacy('{"id":"e1","action":"x","metadata":{"n":"9007199254740993"}}'));
  expect(legacy(number)).toBe(legacy('{"id":"e1","action":"x","metadata":{"n":9007199254740992}}'));
});

it('bounds how far a compact number expands in the search columns', () => {
  const { row } = normalize(wire('{"action":"x","metadata":{"a":1e+2047,"b":1e-2040,"c":1e21},"tenant":{"id":1e+200}}'));
  expect(row.attributes).toMatchObject({ 'metadata.a': '1e2047', 'metadata.b': '1e-2040', 'metadata.c': '1000000000000000000000' });
  expect(row.tenant_id).toBe('1e200');
});

it('numbers extra target fields by the position of the target in the record columns', () => {
  const { row } = normalize(
    wire(`{"action":"x","targets":[{"type":"order","id":${'1'.repeat(300)},"note":"dropped"},{"type":"page","id":"p1","note":"kept"}]}`),
  );
  expect(row.target_ids).toEqual(['p1']);
  expect(row.attributes['targets.0.note']).toBe('kept');
  expect(row.attributes['targets.1.note']).toBeUndefined();
  expect(row.payload).toContain('"note":"dropped"');
});

it('never keeps the partial digits of a number cut by the composite-value cap', () => {
  const head = `[${'"a",'.repeat(511)}`; // 2,045 bytes before the number
  const cut = (n: string) => normalize(wire(`{"action":"x","metadata":{"list":${head}${n}]}}`)).row.attributes['metadata.list'] ?? '';
  const a = cut('12345678901234567891');
  expect(a.length).toBeLessThanOrEqual(2048);
  expect(a.endsWith(',')).toBe(true);
  expect(a).toBe(cut('12399999999999999999'));
  // A value that fits is kept whole.
  expect(normalize(wire('{"action":"x","metadata":{"list":[12345678901234567891]}}')).row.attributes['metadata.list']).toBe(
    '[12345678901234567891]',
  );
});

it('truncates executor.attempt from its exact decimal value, clamped like before', () => {
  const attempt = (n: string) => normalize(wire(`{"action":"x","executor":{"type":"job","attempt":${n}}}`)).row.job_attempt;
  expect(attempt('1.99999999999999999')).toBe(1);
  expect(attempt('3')).toBe(3);
  expect(attempt('2.5')).toBe(2);
  expect(attempt('65534.99999999999999999')).toBe(65_534);
  expect(attempt('1e400')).toBe(65_535);
  expect(attempt('-1.99999999999999999')).toBe(0);
  expect(attempt('0.99999999999999999999')).toBe(0);
  expect(attempt('1e-400')).toBe(0);
});

it('drops a caller-supplied rejected-timestamp attribute when no timestamp was rejected', () => {
  for (const occurredAt of ['', ',"occurredAt":"2026-11-22T11:00:00Z"']) {
    const { row } = normalize(wire(`{"action":"x","logbird":{"occurredAt":{"rejected":"42"}}${occurredAt}}`));
    expect(row.attributes['logbird.occurredAt.rejected']).toBeUndefined();
  }
});
