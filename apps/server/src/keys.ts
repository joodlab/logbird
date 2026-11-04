import { createHash, randomInt } from 'node:crypto';

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const hashApiKey = (secret: string) => createHash('sha256').update(secret).digest('hex');
export function generateApiKey(kind: 'ingest' | 'read') {
  const secret = `tm_${kind}_${Array.from({ length: 32 }, () => alphabet[randomInt(alphabet.length)]).join('')}`;
  return { secret, hash: hashApiKey(secret), prefix: secret.slice(0, 14) };
}
