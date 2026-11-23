import { describe, expect, it } from 'vitest';
import { isForeignMutationCommand, retentionCutoff } from './retention';

describe('retention helpers', () => {
  it('floors the cutoff to the minute', () => {
    const now = Date.UTC(2026, 10, 23, 12, 34, 56, 789);
    expect(retentionCutoff(now, 30).toISOString()).toBe('2026-10-24T12:34:00.000Z');
  });

  // Commands exactly as system.mutations stored them on ClickHouse 26.9 (Logbird's own) and foreign examples.
  it("tells Logbird's literal-only DELETEs from mutations created outside Logbird", () => {
    for (const ours of [
      "(UPDATE _row_exists = 0 WHERE project_id = 'qa-retention-fence-24135a74')",
      "(UPDATE _row_exists = 0 WHERE (project_id = 'p') AND (timestamp < _CAST('1795349860.134', 'DateTime64(3)')))",
      "(UPDATE _row_exists = 0 WHERE (project_id = 'p') AND (bucket <= _CAST('1795435440', 'DateTime64(3)')))",
      "(UPDATE _row_exists = 0 WHERE (project_id = 'p') AND ((kind, entity_id) IN arrayZip(['actor'], ['a1'])))",
      "(UPDATE _row_exists = 0 WHERE (project_id = 'p') AND (hasAny(target_ids, ['t']) OR (actor_id IN ['a'])))",
      "(UPDATE _row_exists = 0 WHERE (project_id = 'p') AND (source IN ['logbird.sample']))",
    ])
      expect(isForeignMutationCommand(ours), ours).toBe(false);
    for (const foreign of [
      "(DELETE WHERE (project_id = 'p') AND (timestamp < now()))",
      "(UPDATE _row_exists = 0 WHERE (project_id = 'p') AND (if(project_id = 'p', sleepEachRow(0.1), 0) = 0))",
      '(DELETE WHERE rand() < 0.5)',
      '(DELETE WHERE event_id IN (SELECT event_id FROM other))',
      "(UPDATE action = 'x' WHERE throwIf(1) = 0)",
    ])
      expect(isForeignMutationCommand(foreign), foreign).toBe(true);
  });
});
