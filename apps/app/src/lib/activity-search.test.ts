import { describe, expect, it } from 'vitest';
import { activityChip, activityFreeText, activityQuery, toggleActivityChip } from './activity-search';

describe('workspace activity search (#226)', () => {
  it('keeps a negated category as a filter, not a chip, and never rewrites it', () => {
    const q = '-category:auth';
    expect(activityChip(q)).toBeUndefined();
    expect(activityFreeText(q)).toBe('-category:auth');
    expect(activityQuery(activityChip(q), activityFreeText(q))).toBe(q);
  });

  it('splits a positive chip from the free text and builds the same query back', () => {
    for (const q of ['category:keys', 'category:keys revoked', 'category:members -category:auth', 'revoked']) {
      expect(activityQuery(activityChip(q), activityFreeText(q)), q).toBe(q);
    }
    expect(activityChip('category:members -category:auth')).toBe('members');
    expect(activityFreeText('category:members -category:auth')).toBe('-category:auth');
  });

  it('toggles a chip and keeps negated categories', () => {
    expect(toggleActivityChip('-category:auth', 'keys')).toBe('category:keys -category:auth');
    expect(toggleActivityChip('category:keys -category:auth', 'keys')).toBe('-category:auth');
    expect(toggleActivityChip('category:keys revoked', 'members')).toBe('category:members revoked');
  });
});
