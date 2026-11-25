// Runs the packed @logbird/sdk and @logbird/hono the way an application does, against an in-process stand-in for the
// Logbird server on a loopback port: no network and no Logbird server. Prints one line per check and exits 1 on the
// first failure.
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type AuditVariables, logbird } from '@logbird/hono';
import {
  type DropDetails,
  type EventInput,
  generateWebhookSecret,
  IDENTIFIER_FIELDS,
  Logbird,
  redact,
  signWebhook,
  verifyWebhook,
  WebhookVerificationError,
} from '@logbird/sdk';
import { createAudit } from '@logbird/sdk/integration';
import { isTrailQueryError, readAuditTrail, trailQuery } from '@logbird/sdk/read';
import { Hono } from 'hono';

const STORED = {
  id: 'evt_1',
  projectId: 'prj_1',
  timestamp: '2026-11-22T08:00:00.123Z',
  receivedAt: '2026-11-22T08:00:01.000Z',
  environment: 'staging',
  action: 'invoice.updated',
  category: 'invoice',
  outcome: 'success',
  severity: 'info',
  description: '',
  actor: { type: 'user', id: 'u1', name: 'Fictional', email: '' },
  impersonator: null,
  executor: null,
  tenant: { id: 't1', name: '' },
  source: null,
  targets: [{ type: 'invoice', id: 'inv_1', name: 'INV-1' }],
  changes: [{ field: 'status', before: 'draft', after: 'sent' }],
  context: { operationId: 'op', parentEventId: '', requestId: 'req', traceId: '', ip: '', userAgent: '' },
  attributes: { 'metadata.plan': 'pro' },
  conformance: 77.8,
  schemaVersion: '',
  sdk: 'js/0.2.1',
};

/** The stand-in: records each ingest batch and acknowledges every event; answers a search with one stored event. */
const received: Record<string, unknown>[] = [];
const searches: URL[] = [];
const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', 'http://stand-in');
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  response.setHeader('content-type', 'application/json');
  if (request.method === 'POST' && url.pathname === '/v1/events') {
    const events = (JSON.parse(body) as { events: Record<string, unknown>[] }).events;
    // An event whose action is `stand-in.reject` is refused by index, as ingest refuses an invalid event; the others
    // are accepted. So the client must read the acknowledgement, not only the 202.
    const rejected = events.flatMap((event, index) =>
      event.action === 'stand-in.reject' ? [{ index, reason: 'invalid_event: fictional rejection', code: 'invalid_event' }] : [],
    );
    const accepted = events.filter((event) => event.action !== 'stand-in.reject');
    received.push(...accepted);
    response.statusCode = 202;
    response.end(JSON.stringify({ accepted: accepted.length, ids: accepted.map((event) => event.id), rejected }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/events') {
    searches.push(url);
    response.end(JSON.stringify({ data: [STORED], nextCursor: null, total: 1, tookMs: 1 }));
    return;
  }
  response.statusCode = 404;
  response.end('{}');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let checks = 0;
function pass(what: string): void {
  checks++;
  console.log(`ok ${checks}: ${what}`);
}
function expect(condition: boolean, what: string): void {
  if (!condition) throw new Error(`expected ${what}`);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

try {
  // 1. The client queues, redacts through beforeSend, sends one batch and reads the acknowledgement.
  const drops: { event: EventInput; details: Readonly<DropDetails> }[] = [];
  const errors: Error[] = [];
  const redactEvent = redact();
  const client = new Logbird({
    endpoint,
    apiKey: 'lb_ingest_fictional',
    flushIntervalMs: 60_000,
    beforeSend: (event) => redactEvent(event.action === 'invoice.sent' ? { ...event, id: 'hook-replacement' } : event),
    shutdownTimeoutMs: 1000,
    onDrop: (event, details) => drops.push({ event, details }),
    onError: (error) => errors.push(error),
  });
  client.track({
    action: 'invoice.updated',
    actor: { type: 'user', id: 'u1', name: 'Fictional User' },
    tenant: { id: 't1' },
    targets: [{ type: 'invoice', id: 'inv_1' }],
    changes: [{ field: 'status', before: 'draft', after: 'sent' }],
    metadata: { plan: 'pro', token: 'fictional-secret' },
  });
  await client.flush();
  const sent = received.at(-1) as { action: string; actor: { id: string }; metadata: Record<string, unknown> } | undefined;
  expect(received.length === 1 && sent?.action === 'invoice.updated', 'one event sent');
  expect(sent?.actor.id === 'u1', 'the actor id to be sent');
  expect(sent?.metadata.plan === 'pro' && sent?.metadata.token === '[redacted]', 'metadata.token redacted, plan kept');
  expect(drops.length === 0 && errors.length === 0, `no drop and no error (drops ${drops.length}, errors ${errors.length})`);
  pass('Logbird track and flush: serialized, redacted by beforeSend, acknowledged');

  // 1b. The acknowledgement is read: in one batch, the event ingest refuses is dropped and reported, the other kept.
  client.track({ action: 'stand-in.reject', actor: { type: 'user', id: 'u1' } });
  client.track({ action: 'invoice.kept', actor: { type: 'user', id: 'u1' } });
  await client.flush();
  expect(drops.length === 1 && drops[0]?.event.action === 'stand-in.reject', `the refused event, and only it, dropped (drops ${drops.length})`);
  const drop = drops[0]?.details;
  expect(drop?.reason === 'rejected' && drop.code === 'invalid_event' && !drop.mayBeStored, 'the drop has a safe rejection code');
  expect(
    client.droppedByReason.rejected === 1 && client.possiblyStoredDropsByReason.rejected === undefined && client.skippedNotifications === 0,
    'the drop was counted with its storage certainty',
  );
  expect(errors.length === 1 && /rejected/.test(errors[0]?.message ?? ''), 'the rejection reported to onError');
  expect(received.at(-1)?.action === 'invoice.kept' && !received.some((event) => event.action === 'stand-in.reject'), 'the other event delivered');
  drops.length = 0;
  errors.length = 0;
  pass('Logbird acknowledgement: a refused event dropped and reported, the rest of the batch kept');

  // 2. The Hono middleware fills the request context; an inbound x-request-id is ignored by default (#321).
  const app = new Hono<{ Variables: AuditVariables }>();
  const capture = logbird({ client, actor: () => ({ type: 'user', id: 'u2' }), tenant: () => ({ id: 't2' }) });
  app.use(capture);
  app.post('/invoices/:id', (c) => c.text(c.get('audit')('invoice.sent', { id: '   ', targets: [{ type: 'invoice', id: c.req.param('id') }] })));
  const response = await app.request('/invoices/inv_9', { method: 'POST', headers: { 'x-request-id': 'req_from_client' } });
  expect(response.status === 200, `the route to answer 200, not ${response.status}`);
  const auditId = await response.text();
  await client.flush();
  const viaHono = received.at(-1) as
    | {
        id: string;
        action: string;
        actor: { id: string };
        tenant: { id: string };
        targets: { id: string }[];
        context: { requestId: string; operationId: string };
      }
    | undefined;
  expect(viaHono?.action === 'invoice.sent' && viaHono.targets[0]?.id === 'inv_9', 'the route event with its target');
  expect(uuid.test(auditId) && viaHono?.id === auditId, 'audit returns the id sent after the hook');
  expect(viaHono?.actor.id === 'u2' && viaHono.tenant.id === 't2', 'the resolved actor and tenant');
  expect(
    uuid.test(viaHono?.context.requestId ?? '') && uuid.test(viaHono?.context.operationId ?? ''),
    'generated request and operation ids, not the inbound header',
  );
  // A second request gets ids of its own: generated per request, not a constant of the right shape.
  await app.request('/invoices/inv_10', { method: 'POST', headers: { 'x-request-id': 'req_from_client' } });
  await client.flush();
  const second = received.at(-1) as { targets: { id: string }[]; context: { requestId: string; operationId: string } } | undefined;
  expect(second?.targets[0]?.id === 'inv_10', 'the second request recorded');
  expect(uuid.test(second?.context.requestId ?? '') && uuid.test(second?.context.operationId ?? ''), 'generated ids on the second request too');
  expect(
    second?.context.requestId !== viaHono?.context.requestId && second?.context.operationId !== viaHono?.context.operationId,
    'distinct ids for each request',
  );
  pass('Hono middleware: recorded in a request, context filled, inbound x-request-id ignored by default');

  // 3. createAudit directly, with the request id header turned on.
  const audit = await createAudit(
    { client, useRequestIdHeader: true },
    {},
    new Request('http://host/', { headers: { 'x-request-id': 'req_trusted' } }),
  );
  audit('direct.capture');
  await audit.pending();
  await client.flush();
  const direct = received.at(-1) as { action: string; context: { requestId: string } } | undefined;
  expect(direct?.action === 'direct.capture' && direct.context.requestId === 'req_trusted', 'the opted-in header to be used');
  pass('createAudit: useRequestIdHeader takes the inbound header');
  await capture.shutdown();

  // 4. A trail read: trailQuery builds the query, readAuditTrail sends it and reads the page; no selector throws.
  const page = await readAuditTrail({ endpoint, readKey: 'lb_read_fictional' }, trailQuery({ target: { type: 'invoice', id: 'inv_1' } }));
  const stored = page.data[0];
  expect(page.total === 1 && stored?.actor?.id === 'u1' && stored.changes[0]?.after === 'sent', 'the stored event read back');
  expect((searches.at(-1)?.searchParams.get('q') ?? '').includes('inv_1'), 'the trail query to name the target');
  let threw = false;
  try {
    trailQuery({});
  } catch (error) {
    threw = isTrailQueryError(error);
  }
  expect(threw, 'a trail without a selector to throw TrailQueryError (#311)');
  pass('readAuditTrail and trailQuery: page read, selector-less trail refused');

  // 5. Webhooks: a signed payload verifies; a tampered one is refused.
  const secret = generateWebhookSecret();
  const payload = JSON.stringify({ type: 'event.created', data: { id: 'evt_1' } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signWebhook({ id: 'msg_1', timestamp, payload, secrets: [secret] });
  const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': String(timestamp), 'webhook-signature': signature };
  const verified = await verifyWebhook<{ data: { id: string } }>({ payload, headers, secret });
  expect(verified.data.id === 'evt_1', 'the verified payload');
  let refused = false;
  try {
    await verifyWebhook({ payload: `${payload} `, headers, secret });
  } catch (error) {
    refused = error instanceof WebhookVerificationError;
  }
  expect(refused, 'a tampered payload to be refused with WebhookVerificationError');
  pass('signWebhook and verifyWebhook: verified, tampered payload refused');

  // 6. Redaction never removes identity: a pattern matching the party key keeps its ids (#345).
  const redacted = redact({ keys: /^actor$/ })({ action: 'a.b', actor: { type: 'user', id: 'u1', name: 'Name', email: 'e@example.test' } });
  expect(redacted.actor?.id === 'u1' && redacted.actor?.type === 'user', 'the actor ids kept');
  expect(redacted.actor?.name === '[redacted]' && redacted.actor?.email === '[redacted]', 'the rest of the actor redacted');
  expect(IDENTIFIER_FIELDS.includes('actor.id'), 'IDENTIFIER_FIELDS to list actor.id');
  pass('redact: a matching party key keeps its identifier fields');

  console.log(`npm consumer: all ${checks} checks passed`);
} catch (error) {
  console.error(`npm consumer: FAILED after ${checks} checks:`, error);
  process.exitCode = 1;
} finally {
  server.close();
}
