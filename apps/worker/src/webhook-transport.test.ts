import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateWebhookSecret, verifyWebhook } from '@logbird/sdk';
import { expect, it } from 'vitest';
import { postWebhook } from './webhook-transport';

const secret = generateWebhookSecret();
it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '[fd00:ec2::254]'])('blocks %s before sending', async (address) => {
  expect(await postWebhook(`http://${address}`, 'signed-id', '{}', [secret], { allowHttp: true })).toEqual({ error: 'destination_rejected' });
});

it('rejects mixed public and private DNS answers', async () => {
  expect(
    await postWebhook('https://receiver.example.invalid', 'signed-id', '{}', [secret], {
      lookup: async () => [
        { address: '1.1.1.1', family: 4 },
        { address: '192.168.1.10', family: 4 },
      ],
    }),
  ).toEqual({ error: 'destination_rejected' });
});

it('pins the validated address, signs a real POST and never follows its redirect', async () => {
  let requests = 0;
  let headers: Record<string, string | string[] | undefined> = {};
  let payload = '';
  const receiver = createServer((request, response) => {
    requests++;
    headers = request.headers;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      payload += chunk;
    });
    request.on('end', () => {
      response.writeHead(302, { Location: '/must-not-follow' });
      response.end('x'.repeat(80_000));
    });
  });
  try {
    receiver.listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    const { port } = receiver.address() as AddressInfo;
    const result = await postWebhook(`http://receiver.example.invalid:${port}/event`, 'signed-id', '{"ok":true}', [secret], {
      allowHttp: true,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      allowAddress: (address) => address === '127.0.0.1',
    });
    expect(result).toEqual({ responseCode: 302, responseBody: 'x'.repeat(2048) });
    expect(requests).toBe(1);
    expect(headers.host).toBe(`receiver.example.invalid:${port}`);
    expect(headers['user-agent']).toMatch(/^Logbird-Webhooks\//);
    expect(headers.cookie).toBeUndefined();
    expect(await verifyWebhook({ payload, headers, secret })).toEqual({ ok: true });
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
});
