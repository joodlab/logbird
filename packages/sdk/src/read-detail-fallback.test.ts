import { expect, it, vi } from 'vitest';

// A runtime without JSON.rawJSON: the detail reader refuses only a number it cannot keep, never digits inside strings.
vi.mock('@logbird/contracts/json', async (original) => ({
  ...(await original<typeof import('@logbird/contracts/json')>()),
  supportsExactJson: false,
}));
const { readAuditEvent } = await import('./read');

const event = (id: string) => ({
  id,
  projectId: 'p',
  timestamp: '2026-11-01T00:00:00.000Z',
  receivedAt: '2026-11-01T00:00:00.000Z',
  environment: 'production',
  action: 'invoice.updated',
  category: 'invoice',
  outcome: 'success',
  severity: 'info',
  description: '',
  actor: null,
  impersonator: null,
  executor: null,
  tenant: null,
  source: null,
  targets: [],
  changes: [],
  context: { operationId: '', parentEventId: '', requestId: '', traceId: '', ip: '', userAgent: '' },
  attributes: { account: '12345678901234567890' },
  conformance: 50,
  schemaVersion: '',
  sdk: '',
});
const reader = (body: string) => ({
  endpoint: 'https://logbird.test',
  readKey: 'k',
  fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
});
const detail = (id: string, payload: string) =>
  `{"event":${JSON.stringify(event(id))},"payload":${payload},"parents":[],"childCount":0,"operationSize":1}`;

it('reads a detail whose long digits are only inside strings', async () => {
  const read = await readAuditEvent(reader(detail('1234567890123456', 'null')), '1234567890123456');
  expect(read?.event.id).toBe('1234567890123456');
});

it('refuses a detail holding a number a double cannot keep, however long, rather than rounding it', async () => {
  await expect(readAuditEvent(reader(detail('e1', '{"accountId":9007199254740993}')), 'e1')).rejects.toMatchObject({ code: 'read_inexact_number' });
  // A digit past the first 4,096 characters of a token still counts.
  await expect(readAuditEvent(reader(detail('e1', `{"ratio":1.${'0'.repeat(4094)}1}`)), 'e1')).rejects.toMatchObject({ code: 'read_inexact_number' });
  const exact = await readAuditEvent(reader(detail('e1', '{"n":12.5,"big":9007199254740992}')), 'e1');
  expect(exact?.payload).toEqual({ n: 12.5, big: 9_007_199_254_740_992 });
});
