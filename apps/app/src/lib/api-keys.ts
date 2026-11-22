import type { ApiKey } from '@logbird/contracts';

/** A key past its `expiresAt` is refused by the API like a revoked one (#138). */
export const isKeyExpired = (key: Pick<ApiKey, 'expiresAt'>, now = Date.now()) => Boolean(key.expiresAt && Date.parse(key.expiresAt) <= now);
/** Usable = not revoked and not expired: the only keys setup and rotation guidance may offer or rely on. */
export const isKeyUsable = (key: Pick<ApiKey, 'revokedAt' | 'expiresAt'>, now = Date.now()) => !key.revokedAt && !isKeyExpired(key, now);
