import { readFileSync } from 'node:fs';
import { eventInputSchema } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { canonicalFingerprint, eventFingerprint, legacyEventFingerprint, retryFingerprint } from './identity';
import { type EventRow, normalizeEvent } from './normalize';

const receivedAt = new Date('2026-11-07T12:00:00Z');
const digest = (input: Record<string, unknown>) => {
  const result = normalizeEvent({ id: 'same', action: 'evidence.original', ...input }, { projectId: 'fictional', receivedAt });
  if (!result.ok) throw new Error(result.reason);
  return eventFingerprint(result.row);
};
it.each([
  [{ changes: [{ field: 'config', after: { a: 1, b: 2 } }] }, { changes: [{ after: { b: 2, a: 1 }, field: 'config' }] }],
  [{ metadata: { items: [{ a: 1, b: 2 }, { c: 3 }] } }, { metadata: { items: [{ b: 2, a: 1 }, { c: 3 }] } }],
  [{ metadata: { a: { b: { c: { d: { e: { f: { a: 1, b: 2 } } } } } } } }, { metadata: { a: { b: { c: { d: { e: { f: { b: 2, a: 1 } } } } } } } }],
  [
    { metadata: Object.fromEntries(Array.from({ length: 270 }, (_, i) => [`k${i}`, i])) },
    { metadata: Object.fromEntries(Array.from({ length: 270 }, (_, i) => [`k${269 - i}`, 269 - i])) },
  ],
])('ignores recursive key order, including arrays and capped indexing (%#)', (a, b) => {
  expect(digest(a)).toMatch(/^v1:[a-f0-9]{64}$/);
  expect(digest(a)).toBe(digest(b));
});
it.each([
  [{ actor: { id: 42 } }, { actor: { id: 43 } }],
  [{ environment: 42 }, { environment: 43 }],
  [{ executor: { attempt: '3' } }, { executor: { attempt: '4' } }],
  [{ description: `${'x'.repeat(4096)}a` }, { description: `${'x'.repeat(4096)}b` }],
  [{ metadata: { value: `${'x'.repeat(2048)}a` } }, { metadata: { value: `${'x'.repeat(2048)}b` } }],
  [{ metadata: { items: [{ a: 1 }, { b: 2 }] } }, { metadata: { items: [{ b: 2 }, { a: 1 }] } }],
  [{ action: ' evidence.original ' }, { action: 'evidence.original' }],
  [{ changes: [{ field: 'x', extra: 1 }] }, { changes: [{ field: 'x', extra: 2 }] }],
  [{ action: `${'x'.repeat(200)}a` }, { action: `${'x'.repeat(200)}b` }],
  [
    { targets: [...new Array(64).fill({ type: 'x', id: 'x' }), { type: 'x', id: 'a' }] },
    { targets: [...new Array(64).fill({ type: 'x', id: 'x' }), { type: 'x', id: 'b' }] },
  ],
  [{ changes: [...new Array(256).fill({ field: 'x' }), { field: 'a' }] }, { changes: [...new Array(256).fill({ field: 'x' }), { field: 'b' }] }],
  [
    { metadata: { ...Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`k${i}`, i])), beyond: 'a' } },
    { metadata: { ...Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`k${i}`, i])), beyond: 'b' } },
  ],
])('preserves input differences even beyond lossy indexing (%#)', (a, b) => expect(digest(a)).not.toBe(digest(b)));
it.each([undefined, 'invalid', 123])('uses original receive clock for occurredAt=%s', (occurredAt) => {
  const input = { id: 'same', action: 'evidence.original', occurredAt };
  expect(retryFingerprint(input, 'fictional', receivedAt, 'same')).toBe(digest({ occurredAt }));
});
const goldens = JSON.parse(readFileSync(new URL('./fixtures/identity-goldens.json', import.meta.url), 'utf8')) as {
  sourceRevision: string;
  cases: { input: Record<string, unknown>; projectId: string; receivedAt: string; row: EventRow; legacy: string; v1: string }[];
};
it.each(goldens.cases)('preserves frozen 3a1541f legacy and v1 vectors for $row.event_id', (vector) => {
  expect(goldens.sourceRevision).toBe('3a1541f632ce4be4c42b022a7da0d83fa6e7fbbd');
  expect(legacyEventFingerprint(vector.row)).toBe(vector.legacy);
  expect(canonicalFingerprint(vector.input, vector.row.timestamp)).toBe(vector.v1);
  expect(
    retryFingerprint(vector.input, vector.projectId, new Date(vector.receivedAt), vector.row.event_id, vector.v1, new Date(vector.row.timestamp)),
  ).toBe(vector.v1);
  // Old id truncation is represented by the frozen row; the safe stored id can recover an unversioned claim.
  expect(
    retryFingerprint({ ...vector.input, id: vector.row.event_id }, vector.projectId, new Date(vector.receivedAt), vector.row.event_id, vector.legacy),
  ).toBe(vector.legacy);
});
it.each(['a\0b', '\ud800', `${'x'.repeat(255)}😀`, 'x'.repeat(257)])('rejects an unsafe id individually (%#)', (id) => {
  expect(normalizeEvent({ id, action: 'safe' }, { projectId: 'fictional', receivedAt })).toMatchObject({
    ok: false,
    reason: expect.stringMatching(/^invalid_event_id:/),
  });
});
it('preserves a complete Unicode pair at the length boundary', () => {
  const id = `${'x'.repeat(254)}😀`;
  expect(normalizeEvent({ id, action: 'safe' }, { projectId: 'fictional', receivedAt })).toMatchObject({ ok: true, id });
});

it.each([
  ['action', 200],
  ['environment', 64],
  ['outcome', 32],
  ['severity', 32],
  ['description', 4096],
  ['actor.type', 64],
  ['actor.id', 256],
  ['actor.name', 512],
  ['actor.email', 512],
  ['impersonator.id', 256],
  ['impersonator.name', 512],
  ['executor.type', 64],
  ['executor.id', 256],
  ['executor.name', 512],
  ['executor.jobId', 256],
  ['tenant.id', 256],
  ['tenant.name', 512],
  ['source', 128],
  ['schemaVersion', 32],
  ['context.operationId', 256],
  ['context.parentEventId', 256],
  ['context.requestId', 256],
  ['context.traceId', 64],
  ['context.ip', 64],
  ['context.userAgent', 1024],
] as const)('includes content beyond the %s cap (%i)', (path, cap) => {
  const input = (suffix: string) => {
    let value: unknown = `${'x'.repeat(cap)}${suffix}`;
    for (const key of path.split('.').reverse()) value = { [key]: value };
    return value as Record<string, unknown>;
  };
  expect(digest(input('a'))).not.toBe(digest(input('b')));
});
it.each([
  ['type', 64],
  ['id', 256],
  ['name', 512],
] as const)('includes target %s beyond its cap', (field, cap) => {
  expect(digest({ targets: [{ [field]: `${'x'.repeat(cap)}a` }] })).not.toBe(digest({ targets: [{ [field]: `${'x'.repeat(cap)}b` }] }));
});
it('includes capped numeric attempts, change field names and deep metadata leaves', () => {
  expect(digest({ executor: { attempt: 65_536 } })).not.toBe(digest({ executor: { attempt: 65_537 } }));
  expect(digest({ changes: [{ field: `${'x'.repeat(256)}a` }] })).not.toBe(digest({ changes: [{ field: `${'x'.repeat(256)}b` }] }));
  expect(digest({ metadata: { a: { b: { c: { d: { e: { f: { leaf: 1 } } } } } } } })).not.toBe(
    digest({ metadata: { a: { b: { c: { d: { e: { f: { leaf: 2 } } } } } } } }),
  );
});

it('checks the trimmed id length consistently and warns when a numeric id generates a UUID', () => {
  const input = { id: ` ${'x'.repeat(250)} `, action: 'event' };
  expect(eventInputSchema.safeParse(input).success).toBe(true);
  expect(normalizeEvent(input, { projectId: 'fictional', receivedAt })).toMatchObject({ ok: true, id: 'x'.repeat(250) });
  expect(normalizeEvent({ id: 42, action: 'event' }, { projectId: 'fictional', receivedAt })).toMatchObject({
    ok: true,
    warning: expect.stringContaining('Numeric id'),
  });
});
