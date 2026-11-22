import { type ApiKey, createApiKeySchema } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import {
  createKeyBody,
  EMPTY_KEY_FORM,
  expectedFromBody,
  expectedFromRoll,
  expiresSoon,
  expiryFor,
  grantDifferences,
  isKeyExpired,
  isKeyUsable,
  type KeyFormValues,
  validateKeyForm,
} from './api-keys';
import { viewerTokenSnippet } from './snippets';

const now = Date.parse('2026-11-22T10:00:00Z');

it('treats revoked and expired keys as unusable', () => {
  expect(isKeyUsable({ revokedAt: null, expiresAt: null }, now)).toBe(true);
  expect(isKeyUsable({ revokedAt: null, expiresAt: '2026-11-22T10:00:01Z' }, now)).toBe(true);
  expect(isKeyUsable({ revokedAt: null, expiresAt: '2026-11-22T10:00:00Z' }, now)).toBe(false);
  expect(isKeyExpired({ expiresAt: '2026-11-22T09:00:00Z' }, now)).toBe(true);
  expect(isKeyUsable({ revokedAt: '2026-11-21T00:00:00Z', expiresAt: null }, now)).toBe(false);
});

it('flags usable keys that expire within a week', () => {
  expect(expiresSoon({ revokedAt: null, expiresAt: '2026-11-25T10:00:00Z' }, now)).toBe(true);
  expect(expiresSoon({ revokedAt: null, expiresAt: '2026-12-25T10:00:00Z' }, now)).toBe(false);
  expect(expiresSoon({ revokedAt: null, expiresAt: '2026-11-21T10:00:00Z' }, now)).toBe(false); // already expired
  expect(expiresSoon({ revokedAt: null, expiresAt: null }, now)).toBe(false);
});

const scoped = (patch: Partial<KeyFormValues>): KeyFormValues => ({ ...EMPTY_KEY_FORM, name: 'Site 42 dashboard', kind: 'scoped-read', tenantId: 'biz_5', ...patch });

describe('the create form', () => {
  it('builds a contract-valid body for every kind', () => {
    const full = scoped({
      targetType: 'website',
      targetId: 'site_42',
      actionPrefixes: 'booking.\n\nauth.\n',
      masks: ['actor_email', 'ip'],
      embedOrigins: 'https://cms.example.com\nhttp://localhost:3000',
      expiry: '90d',
    });
    expect(validateKeyForm(full)).toEqual({});
    const body = createKeyBody(full, now);
    expect(body).toEqual({
      name: 'Site 42 dashboard',
      kind: 'scoped-read',
      scope: { tenantId: 'biz_5', target: { type: 'website', id: 'site_42' }, actionPrefixes: ['booking.', 'auth.'], mask: ['ip', 'actor_email'] },
      embedOrigins: ['https://cms.example.com', 'http://localhost:3000'],
      expiresAt: '2027-02-20T10:00:00.000Z',
    });
    expect(createApiKeySchema.safeParse(body).success).toBe(true);
    // Ingest keys never carry scope fields or origins left in the form from another kind.
    const ingest = createKeyBody({ ...full, kind: 'ingest' }, now);
    expect(ingest).toEqual({ name: 'Site 42 dashboard', kind: 'ingest', expiresAt: '2027-02-20T10:00:00.000Z' });
    expect(createApiKeySchema.safeParse(ingest).success).toBe(true);
    const read = createKeyBody({ ...full, kind: 'read', expiry: 'never' }, now);
    expect(read).toEqual({ name: 'Site 42 dashboard', kind: 'read', embedOrigins: ['https://cms.example.com', 'http://localhost:3000'] });
    expect(createApiKeySchema.safeParse(read).success).toBe(true);
  });

  it('names each problem against the contract limits before submit', () => {
    expect(validateKeyForm(scoped({ tenantId: '' })).tenantId).toBe('Enter the tenant id this key may read.');
    expect(validateKeyForm(scoped({ tenantId: ' biz_5' })).tenantId).toMatch(/spaces at the start or end/);
    expect(validateKeyForm(scoped({ tenantId: 'x'.repeat(251) })).tenantId).toBe('At most 250 characters (this has 251).');
    expect(validateKeyForm(scoped({ tenantId: `biz${String.fromCharCode(0)}` })).tenantId).toMatch(/NUL or invalid Unicode/);
    expect(validateKeyForm(scoped({ tenantId: 'biz�' })).tenantId).toMatch(/NUL or invalid Unicode/);
    expect(validateKeyForm(scoped({ targetType: 'website' })).targetId).toBe('Enter the target id too, or clear the target type.');
    expect(validateKeyForm(scoped({ targetType: 't'.repeat(61), targetId: 'x' })).targetType).toBe('At most 60 characters (this has 61).');
    expect(validateKeyForm(scoped({ actionPrefixes: `booking.\n${'a'.repeat(191)}` })).actionPrefixes).toBe('Line 2: At most 190 characters (this has 191).');
    expect(validateKeyForm(scoped({ actionPrefixes: Array.from({ length: 21 }, (_, i) => `a${i}.`).join('\n') })).actionPrefixes).toBe(
      'At most 20 prefixes (this has 21).',
    );
    expect(validateKeyForm(scoped({ embedOrigins: 'https://cms.example.com/\n' })).embedOrigins).toMatch(/^Line 1: use a lowercase origin/);
    expect(validateKeyForm({ ...EMPTY_KEY_FORM, kind: 'read', embedOrigins: 'https://App.example.com' }).embedOrigins).toMatch(/^Line 1/);
    // Scope fields are ignored for other kinds.
    expect(validateKeyForm({ ...EMPTY_KEY_FORM, name: 'x', kind: 'ingest', tenantId: ' bad', embedOrigins: 'nope' })).toEqual({});
  });

  it('offers expiries as absolute instants from now', () => {
    expect(expiryFor('never', now)).toBeUndefined();
    expect(expiryFor('30d', now)).toBe('2026-12-22T10:00:00.000Z');
    expect(expiryFor('1y', now)).toBe('2027-11-22T10:00:00.000Z');
  });
});

const key = (patch: Partial<ApiKey>): ApiKey => ({
  id: 'k1',
  projectId: 'p1',
  name: 'Site 42 dashboard',
  kind: 'scoped-read',
  prefix: 'lb_read_abcd',
  scope: { tenantId: 'biz_5', mask: ['ip', 'actor_email'] },
  embedOrigins: ['https://cms.example.com'],
  expiresAt: '2027-02-20T10:00:00.000Z',
  createdAt: '2026-11-22T10:00:00.000Z',
  createdBy: null,
  lastUsedAt: null,
  lastUsedUserAgent: null,
  replacesKeyId: null,
  revokedAt: null,
  ...patch,
});

describe('what the server returned', () => {
  const body = createKeyBody(scoped({ masks: ['actor_email', 'ip'], embedOrigins: 'https://cms.example.com', expiry: '90d' }), now);

  it('matches when the server granted what was asked for (mask order aside)', () => {
    expect(grantDifferences(expectedFromBody(body), key({}))).toEqual([]);
  });

  it('names every difference, as an older server that ignores expiry or scope would return', () => {
    expect(grantDifferences(expectedFromBody(body), key({ expiresAt: null }))).toEqual(['expiry']);
    expect(grantDifferences(expectedFromBody(body), key({ kind: 'read', scope: null, embedOrigins: [] }))).toEqual([
      'permission',
      'scope',
      'embed origins',
    ]);
  });

  it('expects a roll to keep the old expiry unless a new one was chosen', () => {
    const old = key({ id: 'old' });
    expect(grantDifferences(expectedFromRoll(old, undefined), key({ replacesKeyId: 'old' }))).toEqual([]);
    expect(grantDifferences(expectedFromRoll(old, '2027-11-22T10:00:00.000Z'), key({ replacesKeyId: 'old' }))).toEqual(['expiry']);
  });
});

it('shows how a server mints a viewer token, quoting ids for the shell', () => {
  const snippet = viewerTokenSnippet('lb_read_secret', { tenantId: "o'brien", target: { type: 'website', id: 'site_42' } });
  expect(snippet).toContain('-H "Authorization: Bearer lb_read_secret"');
  expect(snippet).toContain(`-d '{"scope":{"tenantId":"o'"'"'brien","target":{"type":"website","id":"site_42"}},"ttlSeconds":900}'`);
  expect(snippet).toContain('Authorization: Bearer $LOGBIRD_VIEWER_TOKEN');
  expect(viewerTokenSnippet()).toContain('$LOGBIRD_READ_KEY');
});
