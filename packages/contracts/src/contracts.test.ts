import { describe, expect, it } from 'vitest';
import { apiKeySchema, createSavedViewSchema, routes, workspaceNameSuggestionSchema } from './index';

const key = {
  id: 'key_1',
  projectId: 'proj_1',
  name: 'QA reader',
  kind: 'read',
  prefix: 'lb_read_AbCd',
  createdAt: '2026-11-08T10:00:00.000Z',
  createdBy: null,
  lastUsedAt: '2026-11-08T10:05:00.000Z',
  revokedAt: null,
};

describe('#63 / #65 contract additions', () => {
  it('API keys carry the last-used client and the key a rolled key replaces', () => {
    expect(apiKeySchema.parse({ ...key, lastUsedUserAgent: 'curl/8.4.0', replacesKeyId: 'key_0' })).toMatchObject({
      lastUsedUserAgent: 'curl/8.4.0',
      replacesKeyId: 'key_0',
    });
    expect(apiKeySchema.safeParse(key).success).toBe(false);
  });

  it('saved views may label entity terms with display names, bounded', () => {
    const state = { q: 'tenant:biz_5', range: '7d', labels: [{ field: 'tenant', value: 'biz_5', label: 'Bayt Al Rimal' }] };
    expect(createSavedViewSchema.parse({ name: 'Bayt Al Rimal — last 7 days', description: null, state }).state.labels).toHaveLength(1);
    expect(
      createSavedViewSchema.safeParse({ name: 'x', description: null, state: { labels: [{ field: 'attr.x', value: 'a', label: 'b' }] } }).success,
    ).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({ field: 'actor', value: `usr_${i}`, label: `Person ${i}` }));
    expect(createSavedViewSchema.safeParse({ name: 'x', description: null, state: { labels: many } }).success).toBe(false);
    // Views saved before labels existed stay valid.
    expect(createSavedViewSchema.safeParse({ name: 'x', description: null, state: { q: 'outcome:failure' } }).success).toBe(true);
  });

  it('declares the roll and workspace-name routes', () => {
    expect(routes.keys.roll).toEqual({ method: 'POST', path: '/api/projects/:projectId/keys/:keyId/roll', auth: 'session' });
    expect(routes.workspaceNameSuggestion).toEqual({ method: 'GET', path: '/api/onboarding/workspace-name', auth: 'session' });
    expect(workspaceNameSuggestionSchema.parse({ name: null })).toEqual({ name: null });
  });
});
