import { EVENT_LIMITS, parseJsonExact, TRUNCATED_ATTRIBUTES } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import { normalizeEvent } from './normalize';

const ctx = { projectId: 'qa-cuts', receivedAt: new Date('2026-11-25T12:00:00.000Z') };
const targets = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'doc', id: `doc_${i}` }));
const changes = (n: number) => Array.from({ length: n }, (_, i) => ({ field: `item${i}`, before: i, after: i + 1 }));
function normalized(input: Record<string, unknown>, legacyColumns = false) {
  const result = normalizeEvent({ action: 'bulk.updated', ...input }, { ...ctx, legacyColumns });
  if (!result.ok) throw new Error(result.reason);
  return result;
}

describe('cuts at ingest', () => {
  it('keeps the event, indexes the first 64 targets and records how many were sent', () => {
    const result = normalized({ targets: targets(70) });
    expect(result.row.target_ids).toHaveLength(EVENT_LIMITS.targets);
    expect(result.row.target_ids.at(-1)).toBe('doc_63');
    expect(JSON.parse(result.row.payload).targets).toHaveLength(70);
    expect(result.row.attributes[TRUNCATED_ATTRIBUTES.targets]).toBe('70');
    expect(result.cuts).toEqual([
      { code: 'targets_truncated', sent: 70, indexed: 64, limit: 64, reason: expect.stringMatching(/^70 targets sent, 64 indexed/) },
    ]);
  });

  it('indexes the first 256 changes and records how many were sent', () => {
    const result = normalized({ changes: changes(300) });
    expect(result.row.changes_fields).toHaveLength(EVENT_LIMITS.changes);
    expect(result.row.changes_fields.at(-1)).toBe('item255');
    expect(result.row.attributes[TRUNCATED_ATTRIBUTES.changes]).toBe('300');
    expect(result.cuts).toEqual([
      { code: 'changes_truncated', sent: 300, indexed: 256, limit: 256, reason: expect.stringMatching(/^300 changes sent, the first 256 indexed/) },
    ]);
  });

  it('counts change field names that were cut, and keeps them whole in the payload', () => {
    const long = 'f'.repeat(300);
    const result = normalized({
      changes: [
        { field: long, after: 1 },
        { field: 'title', after: 'x' },
        { field: `  ${'g'.repeat(257)}  `, after: 2 },
      ],
    });
    expect(result.row.changes_fields.map((f) => f.length)).toEqual([256, 5, 256]);
    expect(result.row.attributes[TRUNCATED_ATTRIBUTES.changeFields]).toBe('2');
    expect(JSON.parse(result.row.payload).changes[0].field).toBe(long);
    expect(result.cuts).toEqual([
      { code: 'change_fields_truncated', cut: 2, limit: 256, reason: expect.stringMatching(/^2 change field names longer than 256/) },
    ]);
  });

  it('reports several cuts of one event, one per kind', () => {
    const result = normalized({ targets: targets(65), changes: [...changes(256), { field: 'x'.repeat(257) }] });
    expect(result.cuts.map((c) => c.code)).toEqual(['targets_truncated', 'changes_truncated']);
    // The 257th change is not indexed, so its long name is not a field-name cut of the indexed copy.
    expect(result.row.attributes[TRUNCATED_ATTRIBUTES.changeFields]).toBeUndefined();
  });

  it('flags nothing at exactly the limits', () => {
    const result = normalized({ targets: targets(64), changes: [...changes(255), { field: 'y'.repeat(256) }] });
    expect(result.cuts).toEqual([]);
    expect(Object.keys(result.row.attributes).filter((k) => k.startsWith('logbird.'))).toEqual([]);
  });

  it('counts a numeric target id too long to index as not indexed', () => {
    // 300 significant digits: no index text fits the id column, so the target is left out of the record columns.
    const result = normalized({ targets: [{ type: 'doc', id: 1 }, parseJsonExact(`{"type":"doc","id":${'9'.repeat(300)}}`)] });
    expect(result.row.target_ids).toEqual(['1']);
    expect(result.cuts).toEqual([expect.objectContaining({ code: 'targets_truncated', sent: 2, indexed: 1 })]);
  });

  it('never keeps a producer value under logbird.truncated: a cut cannot be forged or hidden', () => {
    const forged = normalized({
      targets: targets(2),
      logbird: { truncated: { targets: '999', changes: '5', other: 'x' } },
      'logbird.truncated': 'flat',
      'logbird.truncated.changeFields': '7',
      metadata: { logbird: { truncated: { targets: 'kept' } } },
    });
    expect(Object.keys(forged.row.attributes).filter((k) => k.startsWith('logbird.truncated'))).toEqual([]);
    expect(forged.row.attributes['metadata.logbird.truncated.targets']).toBe('kept');
    expect(forged.cuts).toEqual([]);
    // A real cut wins over a producer value for the same key.
    const real = normalized({ targets: targets(66), logbird: { truncated: { targets: '1' } } });
    expect(real.row.attributes[TRUNCATED_ATTRIBUTES.targets]).toBe('66');
  });

  it('leaves the frozen legacy columns as they were (no cut attributes, producer keys untouched)', () => {
    const legacy = normalized({ targets: targets(70), logbird: { truncated: { targets: '3' } } }, true);
    expect(legacy.cuts).toEqual([]);
    expect(legacy.row.attributes[TRUNCATED_ATTRIBUTES.targets]).toBe('3');
  });

  it('still rejects only an event over the size limit, never one over a cut limit', () => {
    expect(normalizeEvent({ action: 'x', targets: targets(1000), changes: changes(1000) }, ctx).ok).toBe(true);
    const big = normalizeEvent({ action: 'x', note: 'n'.repeat(EVENT_LIMITS.payloadBytes) }, ctx);
    expect(big).toMatchObject({ ok: false, reason: 'event exceeds 256 KB' });
  });
});

describe('the reserved prefix and the attribute budget', () => {
  it('admits exactly what it admitted before: a producer key under logbird.truncated still takes its budget slot', () => {
    // One reserved key, 255 ordinary ones, then a key with a lone surrogate: the budget is full before that key, so it
    // is skipped (never checked), as before this change. The reserved key is then dropped.
    const fields: Record<string, unknown> = { 'logbird.truncated.targets': '9' };
    for (let i = 0; i < EVENT_LIMITS.attributes - 1; i++) fields[`a${i}`] = 'x';
    fields[`bad${String.fromCharCode(0xd8_00)}key`] = 'x';
    const result = normalized(fields);
    expect(Object.keys(result.row.attributes)).toHaveLength(EVENT_LIMITS.attributes - 1);
    expect(result.row.attributes[TRUNCATED_ATTRIBUTES.targets]).toBeUndefined();
  });

  it('adds its own reserved keys after a full budget', () => {
    const full = Object.fromEntries(Array.from({ length: EVENT_LIMITS.attributes + 10 }, (_, i) => [`a${i}`, 'x']));
    const result = normalized({ metadata: full, targets: targets(65) });
    const keys = Object.keys(result.row.attributes);
    expect(keys.filter((k) => k.startsWith('metadata.'))).toHaveLength(EVENT_LIMITS.attributes);
    expect(result.row.attributes[TRUNCATED_ATTRIBUTES.targets]).toBe('65');
  });
});
