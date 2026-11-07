import { createHmac } from 'node:crypto';
/** v1: purpose-derived key, trimmed lower-case canonical address. The version is stored separately. */
export function authEmailHash(email: string, secret: string) {
  const key = createHmac('sha256', secret).update('logbird/auth-audit/hash/v1').digest();
  return createHmac('sha256', key).update(email.trim().toLowerCase()).digest('hex');
}
