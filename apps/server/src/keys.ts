import { createHash, randomInt } from 'node:crypto';

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const hashApiKey = (secret: string) => createHash('sha256').update(secret).digest('hex');
/**
 * Secrets are `lb_<kind>_<32 random>`. Restricted keys (with a scope or an expiry, #138) use 48 random characters:
 * releases before scoped keys only accept 32, so after a rollback a restricted key fails closed (401) instead of
 * being treated as an unrestricted project key.
 */
export function generateApiKey(kind: 'ingest' | 'read', restricted = false) {
  const length = restricted ? 48 : 32;
  const secret = `lb_${kind}_${Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('')}`;
  return { secret, hash: hashApiKey(secret), prefix: secret.slice(0, 14) };
}

/** The random part: 32 characters (legacy and unrestricted keys) or 48 (restricted keys). */
export const API_KEY_BODY = '(?:[A-Za-z0-9]{48}|[A-Za-z0-9]{32})';
/** Stored legacy credentials remain valid; generation always uses the current prefix. */
export function isApiKey(secret: string, kind: 'ingest' | 'read') {
  return new RegExp(`^(?:lb|tm)_${kind}_${API_KEY_BODY}$`).test(secret);
}
