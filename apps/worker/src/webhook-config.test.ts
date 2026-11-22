import { webhookSecretKey } from '@logbird/database/webhooks';
import { expect, it } from 'vitest';
import { webhookSigningConfig } from './webhook-config';

it('reports the missing key needed by startup and readiness', () => {
  expect(webhookSigningConfig({})).toEqual({
    key: null,
    event: 'webhook.delivery_key_missing',
    message: 'Set WEBHOOK_SECRET_KEY or BETTER_AUTH_SECRET to match the API.',
  });
});

it('uses the same signing key as the API and prioritizes the explicit setting', () => {
  const authSecret = 'qa-auth-secret-for-testing-config';
  const explicit = Buffer.alloc(32, 5).toString('base64');
  expect(webhookSigningConfig({ BETTER_AUTH_SECRET: authSecret }).key).toEqual(webhookSecretKey(authSecret));
  expect(webhookSigningConfig({ BETTER_AUTH_SECRET: authSecret, WEBHOOK_SECRET_KEY: explicit }).key).toEqual(Buffer.from(explicit, 'base64'));
  expect(webhookSigningConfig({ BETTER_AUTH_SECRET: authSecret, WEBHOOK_SECRET_KEY: 'bad' })).toMatchObject({
    key: null,
    event: 'webhook.delivery_key_invalid',
  });
});
