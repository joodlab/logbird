import { expect, it, vi } from 'vitest';
import { AmbiguousInsertError, type ClickHouseClient, insertEvents } from './client';
import { normalizeEvent } from './normalize';

it.each([
  ['6', "Cannot parse value 'page.view'", false],
  ['60', 'Unknown table events', false],
  ['6', 'Parse failed: while pushing to view logbird.events_mv', true],
  ['60', 'Target missing: while pushing to view logbird.event_ids_mv', true],
])('classifies %s with server context %s', async (code, message, ambiguous) => {
  const row = normalizeEvent({ id: 'safe', action: 'safe' }, { projectId: 'fictional', receivedAt: new Date() });
  if (!row.ok) throw new Error(row.reason);
  const error = Object.assign(new Error(message as string), { code });
  let consumed = false;
  const insert = vi.fn(async (params: { values: AsyncIterable<unknown> }) => {
    for await (const _row of params.values) {
      consumed = true;
    }
    throw error;
  });
  const result = insertEvents({ insert } as unknown as ClickHouseClient, [row.row]);
  if (ambiguous) await expect(result).rejects.toBeInstanceOf(AmbiguousInsertError);
  else await expect(result).rejects.toBe(error);
  expect(consumed).toBe(true);
});
