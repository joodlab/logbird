import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export function webhookSecretKey(authSecret: string, explicitKey?: string): Buffer {
  if (explicitKey !== undefined) {
    const key = Buffer.from(explicitKey, 'base64');
    if (key.length !== 32 || key.toString('base64') !== explicitKey) throw new Error('WEBHOOK_SECRET_KEY must be base64 encoding of 32 bytes');
    return key;
  }
  if (authSecret.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  return Buffer.from(hkdfSync('sha256', authSecret, '', 'logbird-webhook-secrets-v1', 32));
}

export function encryptWebhookSecret(secret: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
}

export function decryptWebhookSecret(stored: string, key: Buffer): string {
  const [version, iv, tag, ciphertext, extra] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !ciphertext || extra !== undefined) throw new Error('Invalid webhook secret envelope');
  const decode = (part: string) => {
    const bytes = Buffer.from(part, 'base64');
    if (bytes.toString('base64') !== part) throw new Error('Invalid webhook secret encoding');
    return bytes;
  };
  const nonce = decode(iv);
  const authTag = decode(tag);
  if (nonce.length !== 12 || authTag.length !== 16) throw new Error('Invalid webhook secret envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(decode(ciphertext)), decipher.final()]).toString('utf8');
}
