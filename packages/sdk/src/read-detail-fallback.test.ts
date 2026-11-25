import { expect, it, vi } from 'vitest';

// A runtime without JSON.rawJSON: the detail reader refuses only a number it cannot keep, never digits inside strings.
vi.mock('@logbird/contracts/json', async (original) => ({
  ...(await original<typeof import('@logbird/contracts/json')>()),
  supportsExactJson: false,
}));
const { readAuditEvent } = await import('./read');

const event = (id: string) => ({ id, timestamp: '2026-11-01T00:00:00.000Z', attributes: { account: '12345678901234567890' } });
const reader = (body: string) => ({
  endpoint: 'https://logbird.test',
  readKey: 'k',
  fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
});

it('reads a detail whose long digits are only inside strings', async () => {
  const body = JSON.stringify({ event: event('1234567890123456'), payload: null, parents: [], childCount: 0, operationSize: 1 });
  const detail = await readAuditEvent(reader(body), '1234567890123456');
  expect(detail?.event.id).toBe('1234567890123456');
});

it('refuses a detail holding a number a double cannot keep, rather than rounding it', async () => {
  const body = `{"event":${JSON.stringify(event('e1'))},"payload":{"accountId":9007199254740993},"parents":[],"childCount":0,"operationSize":1}`;
  await expect(readAuditEvent(reader(body), 'e1')).rejects.toThrow(/cannot keep exactly/);
  const exact = `{"event":${JSON.stringify(event('e1'))},"payload":{"n":12.5,"big":9007199254740992},"parents":[],"childCount":0,"operationSize":1}`;
  expect((await readAuditEvent(reader(exact), 'e1'))?.payload).toEqual({ n: 12.5, big: 9_007_199_254_740_992 });
});
