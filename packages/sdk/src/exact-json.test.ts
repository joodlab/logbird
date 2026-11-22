import { expect, it } from 'vitest';
import { generateWebhookSecret, signWebhook, verifyWebhook } from './webhooks';

it('verifies a webhook and keeps exact digits in the parsed payload', async () => {
  const secret = generateWebhookSecret();
  const payload = '{"type":"event.created","data":{"metadata":{"snowflake":1234567890123456789,"rate":0.12345678901234567890123}}}';
  const id = 'msg_exact';
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signWebhook({ secrets: [secret], id, timestamp, payload });
  const parsed = await verifyWebhook({
    secret,
    headers: { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': signature },
    payload,
  });
  expect(JSON.stringify(parsed)).toBe(payload);
});
