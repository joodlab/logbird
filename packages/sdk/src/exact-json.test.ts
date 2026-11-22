import { afterEach, expect, it, vi } from 'vitest';
import { Logbird, redact } from './index';
import { generateWebhookSecret, signWebhook, verifyWebhook } from './webhooks';

afterEach(() => {
  vi.unstubAllGlobals();
});
const rawJSON = (text: string) => (JSON as JSON & { rawJSON: (t: string) => unknown }).rawJSON(text);

it('sends a JSON.rawJSON 64-bit value with its exact digits, also after redaction', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('{"accepted":1,"ids":["exact"],"rejected":[],"warnings":[]}', { status: 202 }));
  vi.stubGlobal('fetch', fetcher);
  const sdk = new Logbird({ apiKey: 'fictional', endpoint: 'http://exact.invalid', beforeSend: redact() });
  sdk.track({
    id: 'exact',
    action: 'order.paid',
    actor: { type: 'user', id: 42 },
    targets: [{ type: 'order', id: rawJSON('9007199254740993') as never }],
    metadata: { snowflake: rawJSON('1234567890123456789'), password: 'fictional-secret' },
  });
  await sdk.flush();
  const body = String(fetcher.mock.calls[0]?.[1]?.body);
  expect(body).toContain('"snowflake":1234567890123456789');
  expect(body).toContain('"id":9007199254740993');
  expect(body).toContain('"actor":{"type":"user","id":42}');
  expect(body).toContain('"password":"[redacted]"');
});

it('verifies a webhook and keeps exact digits in the parsed payload', async () => {
  const secret = generateWebhookSecret();
  const payload = '{"type":"event.created","data":{"metadata":{"snowflake":1234567890123456789}}}';
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
