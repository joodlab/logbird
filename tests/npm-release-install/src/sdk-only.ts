// An application that installs only @logbird/sdk (no framework integration, so no override). Runs capture, a read and
// webhook verification against an in-process stand-in for the Logbird server on a loopback port. Prints one line per
// check and exits 1 on the first failure.
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateWebhookSecret, Logbird, signWebhook, verifyWebhook } from '@logbird/sdk';
import { readAuditTrail, trailQuery } from '@logbird/sdk/read';

const received: Record<string, unknown>[] = [];
const searches: URL[] = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://stand-in');
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  response.setHeader('content-type', 'application/json');
  if (request.method === 'POST' && url.pathname === '/v1/events') {
    const events = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { events: Record<string, unknown>[] }).events;
    received.push(...events);
    response.statusCode = 202;
    response.end(JSON.stringify({ accepted: events.length, ids: events.map((event) => event.id), rejected: [] }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/events') {
    searches.push(url);
    response.end(JSON.stringify({ data: [], nextCursor: null, total: 0, tookMs: 1 }));
    return;
  }
  response.statusCode = 404;
  response.end('{}');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let checks = 0;
const expect = (condition: boolean, what: string) => {
  if (!condition) throw new Error(`expected ${what}`);
};
const pass = (what: string) => console.log(`ok ${++checks}: ${what}`);

try {
  const client = new Logbird({ endpoint, apiKey: 'fictional-ingest-key', onError: () => undefined });
  client.track({ action: 'invoice.sent', actor: { type: 'user', id: 'u1' }, targets: [{ type: 'invoice', id: 'inv_1' }] });
  await client.shutdown();
  expect(received.length === 1 && received[0]?.action === 'invoice.sent', 'one delivered event');
  expect(typeof received[0]?.id === 'string', 'an event id assigned by the SDK');
  pass('Logbird track and shutdown: delivered and acknowledged');

  const page = await readAuditTrail({ endpoint, readKey: 'fictional-read-key' }, trailQuery({ target: { type: 'invoice', id: 'inv_1' } }));
  expect(Array.isArray(page.data) && searches.length === 1 && Boolean(searches[0]?.searchParams.get('q')), 'a read with a query');
  pass('readAuditTrail and trailQuery: page read');

  const secret = generateWebhookSecret();
  const payload = JSON.stringify({ type: 'event.created', data: { id: 'evt_1' } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signWebhook({ id: 'msg_1', timestamp, payload, secrets: [secret] });
  const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': String(timestamp), 'webhook-signature': signature };
  const verified = await verifyWebhook<{ data: { id: string } }>({ payload, headers, secret });
  expect(verified.data.id === 'evt_1', 'the verified payload');
  pass('signWebhook and verifyWebhook');

  console.log(`sdk-only consumer: all ${checks} checks passed`);
} catch (error) {
  console.error(`sdk-only consumer: FAILED after ${checks} checks:`, error);
  process.exitCode = 1;
} finally {
  server.close();
}
