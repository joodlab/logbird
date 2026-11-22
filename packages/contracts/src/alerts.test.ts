import { describe, expect, it } from 'vitest';
import { createAlertRuleSchema, updateAlertRuleSchema } from './alerts';

describe('#139 alert rule contract', () => {
  it('accepts each kind with its own fields and defaults', () => {
    const match = createAlertRuleSchema.parse({ name: 'Denied spike', kind: 'match', q: 'outcome:denied' });
    expect(match).toMatchObject({ cooldownMinutes: 15, enabled: true, channels: { emails: [], webhookEndpointIds: [] } });
    expect(
      createAlertRuleSchema.safeParse({
        name: 'Failed sign-ins',
        kind: 'threshold',
        q: 'action:auth.sign_in_failed',
        windowMinutes: 5,
        comparator: '>',
        value: 10,
        groupBy: 'actor',
      }).success,
    ).toBe(true);
    expect(createAlertRuleSchema.safeParse({ name: 'Feed silent', kind: 'silence', silenceMinutes: 30 }).success).toBe(true);
  });
  it('refuses fields of another kind and missing required ones', () => {
    expect(createAlertRuleSchema.safeParse({ name: 'x', kind: 'match', windowMinutes: 5 }).success).toBe(false);
    expect(createAlertRuleSchema.safeParse({ name: 'x', kind: 'silence', silenceMinutes: 30, groupBy: 'actor' }).success).toBe(false);
    expect(createAlertRuleSchema.safeParse({ name: 'x', kind: 'threshold', windowMinutes: 5, comparator: '>' }).success).toBe(false);
    expect(createAlertRuleSchema.safeParse({ name: 'x', kind: 'silence' }).success).toBe(false);
    expect(createAlertRuleSchema.safeParse({ name: 'x', kind: 'match', extra: 1 }).success).toBe(false);
  });
  it('lets PATCH mute, snooze and edit without changing the kind', () => {
    expect(updateAlertRuleSchema.safeParse({ muted: true }).success).toBe(true);
    expect(updateAlertRuleSchema.safeParse({ mutedUntil: '2026-11-23T08:00:00Z' }).success).toBe(true);
    expect(updateAlertRuleSchema.safeParse({ kind: 'silence' }).success).toBe(false);
  });
});
