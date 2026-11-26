import type { HistoryHorizon as ContractHorizon } from '@logbird/contracts';
import { expect, expectTypeOf, it } from 'vitest';
import { type HistoryHorizon, readHistoryHorizon } from './read';

const reader = (body: string, status = 200, seen: URL[] = []) => ({
  endpoint: 'https://logbird.test/',
  readKey: 'lb_read_fictional',
  fetch: (async (url: URL) => {
    seen.push(url);
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch,
});

it('keeps the horizon type aligned with the public contract', () => {
  expectTypeOf<HistoryHorizon>().toEqualTypeOf<ContractHorizon>();
});

it('reads the retention window and the oldest visible event from GET /v1/project', async () => {
  const seen: URL[] = [];
  const horizon = await readHistoryHorizon(reader('{"retentionDays":90,"oldestEventAt":"2026-08-28T09:15:02.481Z"}', 200, seen));
  expect(horizon).toEqual({ retentionDays: 90, oldestEventAt: '2026-08-28T09:15:02.481Z' });
  expect(seen.map(String)).toEqual(['https://logbird.test/v1/project']);
  expect(await readHistoryHorizon(reader('{"retentionDays":7,"oldestEventAt":null}'))).toEqual({ retentionDays: 7, oldestEventAt: null });
});

it('refuses an answer that is not a horizon rather than guessing one', async () => {
  for (const body of [
    '{"retentionDays":90}',
    '{"retentionDays":0,"oldestEventAt":null}',
    '{"retentionDays":"90","oldestEventAt":null}',
    '{"retentionDays":90,"oldestEventAt":"2026-08-28"}',
    '{"retentionDays":90,"oldestEventAt":"2026-08-28T09:15:02Z"}',
    '[]',
    'null',
  ])
    await expect(readHistoryHorizon(reader(body)), body).rejects.toMatchObject({ code: 'read_invalid_response' });
});

it('reports a server without the route as an HTTP error with its status', async () => {
  await expect(readHistoryHorizon(reader('{"error":{"code":"not_found"}}', 404))).rejects.toMatchObject({
    code: 'read_http_error',
    status: 404,
  });
});
