import { describe, expect, it } from 'vitest';
import {
  apiKeySchema,
  createApiKeySchema,
  createSavedViewSchema,
  rollApiKeySchema,
  routes,
  viewerTokenRequestSchema,
  workspaceNameSuggestionSchema,
} from './index';

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
  scope: null,
  embedOrigins: [],
  expiresAt: null,
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

describe('#138 scoped read contract', () => {
  it('requires a scope exactly on scoped-read keys and origins only on read kinds', () => {
    const scope = { tenantId: 'biz_5', target: { type: 'website', id: 'site_42' } };
    expect(createApiKeySchema.safeParse({ name: 'x', kind: 'scoped-read', scope }).success).toBe(true);
    expect(createApiKeySchema.safeParse({ name: 'x', kind: 'scoped-read' }).success).toBe(false);
    expect(createApiKeySchema.safeParse({ name: 'x', kind: 'read', scope }).success).toBe(false);
    expect(createApiKeySchema.safeParse({ name: 'x', kind: 'ingest', embedOrigins: ['https://cms.example.com'] }).success).toBe(false);
    expect(createApiKeySchema.safeParse({ name: 'x', kind: 'read', embedOrigins: ['https://CMS.example.com/'] }).success).toBe(false);
    expect(createApiKeySchema.safeParse({ name: 'x', kind: 'scoped-read', scope: { tenantId: 'b', extra: 1 } }).success).toBe(false);
    // Scope ids must be stored exactly as sent: no surrounding whitespace, no invalid Unicode, under the stored caps.
    for (const tenantId of [' biz_5', 'biz_5 ', 'biz�', 'biz\uD800', 'x'.repeat(251)])
      expect(createApiKeySchema.safeParse({ name: 'x', kind: 'scoped-read', scope: { tenantId } }).success, JSON.stringify(tenantId)).toBe(false);
    expect(createApiKeySchema.safeParse({ name: 'x', kind: 'scoped-read', scope: { tenantId: 'x'.repeat(250) } }).success).toBe(true);
    expect(
      createApiKeySchema.safeParse({ name: 'x', kind: 'scoped-read', scope: { tenantId: 'b', actionPrefixes: ['a'.repeat(191)] } }).success,
    ).toBe(false);
    expect(
      createApiKeySchema.safeParse({ name: 'x', kind: 'scoped-read', scope: { tenantId: 'b', target: { type: 't'.repeat(61), id: 'i' } } }).success,
    ).toBe(false);
    // Scope ids must be stored exactly as sent: no surrounding whitespace, no invalid Unicode, under the stored caps.
    for (const tenantId of [' biz_5', 'biz_5 ', 'biz�', 'biz�', 'x'.repeat(251)])
      expect(createApiKeySchema.safeParse({ name: 'x', kind: 'scoped-read', scope: { tenantId } }).success, JSON.stringify(tenantId)).toBe(false);
    expect(createApiKeySchema.safeParse({ name: 'x', kind: 'scoped-read', scope: { tenantId: 'x'.repeat(250) } }).success).toBe(true);
    expect(
      createApiKeySchema.safeParse({ name: 'x', kind: 'scoped-read', scope: { tenantId: 'b', actionPrefixes: ['a'.repeat(191)] } }).success,
    ).toBe(false);
    expect(
      createApiKeySchema.safeParse({ name: 'x', kind: 'scoped-read', scope: { tenantId: 'b', target: { type: 't'.repeat(61), id: 'i' } } }).success,
    ).toBe(false);
  });
  it('bounds viewer-token lifetimes and keeps roll bodies strict', () => {
    expect(viewerTokenRequestSchema.parse({ scope: { tenantId: 'b' } }).ttlSeconds).toBe(900);
    expect(viewerTokenRequestSchema.safeParse({ scope: { tenantId: 'b' }, ttlSeconds: 3601 }).success).toBe(false);
    expect(viewerTokenRequestSchema.safeParse({ scope: { tenantId: 'b' }, ttlSeconds: 59 }).success).toBe(false);
    expect(rollApiKeySchema.safeParse({}).success).toBe(true);
    expect(rollApiKeySchema.safeParse({ expiresAt: '2027-01-01T00:00:00Z' }).success).toBe(true);
    expect(rollApiKeySchema.safeParse({ scope: { tenantId: 'b' } }).success).toBe(false);
  });
});
