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

it('repairs every search string, changes and rejected date while preserving the raw payload and attribute keys', () => {
  const input = {
    action: '\ud800',
    description: '\udfff',
    occurredAt: '\ud800',
    actor: { name: '\ud800' },
    targets: [{ type: '\ud800', id: '\udfff', name: '\ud800' }],
    changes: [{ field: '\ud800', before: '\ud800', after: '\udfff' }],
    metadata: { '\ud800': '\ud800' },
  };
  const result = normalizeEvent(input, { projectId: 'qa91-unicode', receivedAt: new Date() });
  if (!result.ok) throw new Error(result.reason);
  for (const column of ['action', 'description', 'actor_name'] as const) expect(result.row[column]).toBe('\ufffd');
  for (const column of ['target_types', 'target_ids', 'target_names', 'changes_fields', 'changes_before', 'changes_after'] as const)
    expect(result.row[column]).toEqual(['\ufffd']);
  expect(result.row.attributes['logbird.occurredAt.rejected']).toBe('\ufffd');
  expect(Object.keys(result.row.attributes)).toContain('metadata.\ud800');
  expect(JSON.parse(result.row.payload)).toEqual(input);
});
