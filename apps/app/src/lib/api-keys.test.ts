import { expect, it } from 'vitest';
import { isKeyExpired, isKeyUsable } from './api-keys';

it('treats revoked and expired keys as unusable', () => {
  const now = Date.parse('2026-11-22T10:00:00Z');
  expect(isKeyUsable({ revokedAt: null, expiresAt: null }, now)).toBe(true);
  expect(isKeyUsable({ revokedAt: null, expiresAt: '2026-11-22T10:00:01Z' }, now)).toBe(true);
  expect(isKeyUsable({ revokedAt: null, expiresAt: '2026-11-22T10:00:00Z' }, now)).toBe(false);
  expect(isKeyExpired({ expiresAt: '2026-11-22T09:00:00Z' }, now)).toBe(true);
  expect(isKeyUsable({ revokedAt: '2026-11-21T00:00:00Z', expiresAt: null }, now)).toBe(false);
});
