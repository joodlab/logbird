import { expect, it } from 'vitest';
import { normalizeEvent } from './normalize';

it('does not split valid surrogate pairs at indexed text caps and preserves raw input', () => {
  const input = { action: `${'a'.repeat(199)}😀`, description: `${'a'.repeat(4095)}😀`, actor: { name: `${'a'.repeat(511)}😀` } };
  const result = normalizeEvent(input, { projectId: 'qa91-unicode', receivedAt: new Date() });
  if (!result.ok) throw new Error(result.reason);
  expect(result.row.action).toBe('a'.repeat(199));
  expect(result.row.description).toBe('a'.repeat(4095));
  expect(result.row.actor_name).toBe('a'.repeat(511));
  expect(JSON.parse(result.row.payload)).toEqual(input);
});

it('does not split a valid surrogate pair in the preserved rejected occurredAt', () => {
  const occurredAt = `${'a'.repeat(255)}😀`;
  const result = normalizeEvent({ action: 'qa91.unicode', occurredAt }, { projectId: 'qa91-unicode', receivedAt: new Date() });
  if (!result.ok) throw new Error(result.reason);
  expect(result.row.attributes['logbird.occurredAt.rejected']).toBe('a'.repeat(255));
});

it('repairs every search string, changes and rejected date while preserving the raw payload and valid attribute keys', () => {
  const input = {
    action: '\ud800',
    description: '\udfff',
    occurredAt: '\ud800',
    actor: { name: '\ud800' },
    targets: [{ type: '\ud800', id: '\udfff', name: '\ud800' }],
    changes: [{ field: '\ud800', before: '\ud800', after: '\udfff' }],
    metadata: { '\ud83d\ude00': '\ud800' },
  };
  const result = normalizeEvent(input, { projectId: 'qa91-unicode', receivedAt: new Date() });
  if (!result.ok) throw new Error(result.reason);
  for (const column of ['action', 'description', 'actor_name'] as const) expect(result.row[column]).toBe('\ufffd');
  for (const column of ['target_types', 'target_ids', 'target_names', 'changes_fields', 'changes_before', 'changes_after'] as const)
    expect(result.row[column]).toEqual(['\ufffd']);
  expect(result.row.attributes['logbird.occurredAt.rejected']).toBe('\ufffd');
  expect(Object.keys(result.row.attributes)).toContain('metadata.\ud83d\ude00');
  expect(JSON.parse(result.row.payload)).toEqual(input);
});

it.each([
  { '\ud800': 1 },
  { metadata: { nested: { '\udfff': 1 } } },
  { actor: { nested: { '\ud800': { leaf: 1 } } } },
  { targets: [{ type: 'record', id: 'x', nested: { '\ud800': 1 } }] },
  { metadata: { a: { b: { c: { '\ud800': { leaf: 1 } } } } } },
])('rejects lone surrogates in flattened attribute paths before insert: %j', (attributes) => {
  expect(normalizeEvent({ action: 'qa153.unicode', ...attributes }, { projectId: 'qa153-unicode', receivedAt: new Date() })).toEqual({
    ok: false,
    reason: 'invalid_event: Attribute keys must be valid Unicode',
  });
});

it('keeps a valid surrogate pair in a nested attribute key verbatim', () => {
  const result = normalizeEvent(
    { action: 'qa153.unicode', metadata: { nested: { '\ud83d\ude00': 1 } } },
    { projectId: 'qa153-unicode', receivedAt: new Date() },
  );
  if (!result.ok) throw new Error(result.reason);
  expect(result.row.attributes).toEqual({ 'metadata.nested.\ud83d\ude00': '1' });
});
