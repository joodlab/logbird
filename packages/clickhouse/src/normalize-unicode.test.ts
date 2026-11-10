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
