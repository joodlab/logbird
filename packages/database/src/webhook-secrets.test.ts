import { expect, it } from 'vitest';
import { decryptWebhookSecret, encryptWebhookSecret, webhookSecretKey } from './webhook-secrets';

const auth = 'qa-auth-secret-0123456789abcdef0123456789abcdef';
it('derives a deterministic, domain-separated 256-bit key', () => {
  const key = webhookSecretKey(auth);
  expect(key.toString('hex')).toBe('8fdf5075db7217e7fe1463d01001326b6e8eb8125cc3144b6d0473ad2ed0ce03');
  expect(key).toHaveLength(32);
  expect(key).toEqual(webhookSecretKey(auth));
  expect(key).not.toEqual(webhookSecretKey(`${auth}changed`));
});
it('accepts a stable explicit key independently of the auth secret and rejects malformed keys', () => {
  const explicit = Buffer.alloc(32, 42);
  expect(webhookSecretKey('', explicit.toString('base64'))).toEqual(explicit);
  for (const value of ['', 'bad', Buffer.alloc(31).toString('base64'), `${explicit.toString('base64')}!`])
    expect(() => webhookSecretKey(auth, value)).toThrow('WEBHOOK_SECRET_KEY');
  expect(() => webhookSecretKey('short')).toThrow('BETTER_AUTH_SECRET');
});
it('round trips a secret in a randomized versioned envelope', () => {
  const key = webhookSecretKey(auth),
    secret = `whsec_${Buffer.from('fictional-qa-secret').toString('base64')}`;
  const stored = encryptWebhookSecret(secret, key);
  expect(stored).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
  expect(stored).not.toContain(secret);
  expect(decryptWebhookSecret(stored, key)).toBe(secret);
  expect(encryptWebhookSecret(secret, key)).not.toBe(stored);
  expect(() => decryptWebhookSecret(stored, webhookSecretKey(`${auth}changed`))).toThrow();
});
it.each([1, 2, 3])('authenticates envelope component %s', (component) => {
  const key = webhookSecretKey(auth);
  const parts = encryptWebhookSecret('whsec_qa', key).split(':');
  const part = parts[component];
  if (!part) throw new Error('Envelope component missing');
  const bytes = Buffer.from(part, 'base64');
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  parts[component] = bytes.toString('base64');
  expect(() => decryptWebhookSecret(parts.join(':'), key)).toThrow();
});
it.each(['v2:a:b:c', 'v1:a:b', 'v1:AA==:AA==:AA==', 'v1:a:b:c:extra'])('rejects malformed envelopes: %s', (stored) => {
  expect(() => decryptWebhookSecret(stored, webhookSecretKey(auth))).toThrow();
});
