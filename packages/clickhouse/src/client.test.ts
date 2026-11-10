import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { expect, it, vi } from 'vitest';
import { AmbiguousInsertError, type ClickHouseClient, insertEvents } from './client';
import { normalizeEvent } from './normalize';

it.each([
  ['6', "Cannot parse value 'page.view'", false],
  ['25', 'Cannot parse escape sequence: missing second part of surrogate pair', false],
  ['25', 'Cannot parse escape sequence (while pushing to view logbird.events_mv)', true],
  ['60', 'Unknown table events', false],
  ['209', 'Timeout reading from socket', true],
  ['6', 'Parse failed: while pushing to view logbird.events_mv', true],
  ['60', 'Target missing: while pushing to view logbird.event_ids_mv', true],
  ['60', "Target table 'logbird.event_ids_v2' of view 'logbird.events' doesn't exists: While executing WaitForAsyncInsert.", true],
  ['6', 'Parse failed (while pushing to view logbird.events_mv)', true],
])('classifies %s with server context %s', async (code, message, ambiguous) => {
  const row = normalizeEvent({ id: 'safe', action: 'safe' }, { projectId: 'fictional', receivedAt: new Date() });
  if (!row.ok) throw new Error(row.reason);
  const error = Object.assign(new Error(message as string), { code });
  let consumed = false;
  const exec = vi.fn(async (params: { values: AsyncIterable<unknown> }) => {
    for await (const _row of params.values) {
      consumed = true;
    }
    throw error;
  });
  const result = insertEvents({ exec } as unknown as ClickHouseClient, [row.row]);
  if (ambiguous) await expect(result).rejects.toBeInstanceOf(AmbiguousInsertError);
  else await expect(result).rejects.toBe(error);
  expect(consumed).toBe(true);
});

it('writes one serialized byte body under backpressure and consumes the acknowledgement', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => {
    const n = normalizeEvent(
      { id: `body-${i}`, action: 'body.delivery', metadata: { text: 'line\nUnicode ???????' } },
      { projectId: 'fictional', receivedAt: new Date() },
    );
    if (!n.ok) throw new Error(n.reason);
    return n.row;
  });
  const chunks: Buffer[] = [];
  let acknowledged = false;
  const exec = vi.fn(async (params: { values: Readable }) => {
    await pipeline(
      params.values,
      new Writable({
        highWaterMark: 1,
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk));
          setImmediate(done);
        },
      }),
    );
    return {
      stream: Readable.from(
        (async function* () {
          yield Buffer.from('');
          acknowledged = true;
        })(),
      ),
    };
  });
  await insertEvents({ exec } as unknown as ClickHouseClient, rows);
  expect(chunks).toHaveLength(1);
  expect(
    Buffer.concat(chunks)
      .toString()
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).toEqual(rows);
  expect(exec.mock.calls[0]?.[0]).toMatchObject({ query: 'INSERT INTO events FORMAT JSONEachRow' });
  expect(acknowledged).toBe(true);
});
it.each([21_000, 61_000])('refuses body handoff after a %i ms socket-acquisition pause', async (pause) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const n = normalizeEvent({ id: 'paused', action: 'paused' }, { projectId: 'fictional', receivedAt: new Date() });
    if (!n.ok) throw new Error(n.reason);
    let sent = false;
    const exec = vi.fn(async (params: { values: Readable }) => {
      vi.setSystemTime(Date.now() + pause);
      for await (const _chunk of params.values) sent = true;
      return { stream: Readable.from([]) };
    });
    await expect(insertEvents({ exec } as unknown as ClickHouseClient, [n.row])).rejects.toThrow('Insert lease lacks time');
    expect(sent).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
it('preserves a transport refusal before consuming any body', async () => {
  const n = normalizeEvent({ id: 'before-body', action: 'before.body' }, { projectId: 'fictional', receivedAt: new Date() });
  if (!n.ok) throw new Error(n.reason);
  const error = new Error('connect ECONNREFUSED');
  const exec = vi.fn().mockRejectedValue(error);
  await expect(insertEvents({ exec } as unknown as ClickHouseClient, [n.row])).rejects.toBe(error);
});
