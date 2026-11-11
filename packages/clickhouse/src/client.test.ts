import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import {
  AmbiguousInsertError,
  type ClickHouseClient,
  INGEST_INSERT_SETTINGS,
  InsertLeaseExhaustedError,
  insertEvents,
  isPrewriteParseError,
  LOGBIRD_MATERIALIZED_VIEWS,
} from './client';
import { normalizeEvent } from './normalize';

it.each([
  // A quoted row value that merely contains "view" is still a genuine pre-write parse failure.
  ['6', "Cannot parse value 'page.view': While executing WaitForAsyncInsert.", false],
  ['27', "Cannot parse input: before: 'document.view (preview)': While executing WaitForAsyncInsert.", false],
  ['25', 'Cannot parse escape sequence: While executing WaitForAsyncInsert.', false],
  ['25', 'Cannot parse escape sequence (while pushing to view logbird.events_mv)', true],
  ['25', 'Cannot parse escape sequence: While executing JSONEachRowRowInputFormat.', true],
  ['25', 'Cannot parse escape sequence: unknown future wording', true],
  ['60', 'Unknown table events', false],
  ['452', 'Setting async_insert_max_data_size should not be greater than 1000: SETTING_CONSTRAINT_VIOLATION', false],
  ['209', 'Timeout reading from socket', true],
  ['6', 'Parse failed: while pushing to view logbird.events_mv', true],
  ['60', 'Target missing: while pushing to view logbird.event_ids_mv', true],
  ['60', "Target table 'logbird.event_ids_v2' of view 'logbird.events' doesn't exists: While executing WaitForAsyncInsert.", true],
  ['6', 'Parse failed (while pushing to view logbird.events_mv)', true],
  ['25', 'Parse failed while updating VIEW logbird.events_mv: While executing WaitForAsyncInsert.', true],
  ['60', 'New failure wording for view logbird.events_mv: While executing WaitForAsyncInsert.', true],
  ['25', 'Unfamiliar wording mentioning event_ids_v3_mv: While executing WaitForAsyncInsert.', true],
  ['25', 'Custom database names too: analytics.events_by_minute_mv failed: While executing WaitForAsyncInsert.', true],
  ['25', 'Self-hoster view: logbird.audit_copy_mv failed: While executing WaitForAsyncInsert.', true],
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

// A parse error quotes the offending input. View-shaped event values must not turn it into an endless ambiguity.
// ClickHouse's "before:" excerpt: raw body bytes, with backslashes and single quotes escaped.
const excerpt = (body: string, value: string) => {
  const at = body.indexOf(value);
  return body
    .slice(Math.max(0, at - 16), at + value.length + 6)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'");
};
it.each<[string, string, (body: string) => string, boolean]>([
  ['6', 'events_by_minute_mv', (_body: string) => "Cannot parse value 'events_by_minute_mv': While executing WaitForAsyncInsert.", false],
  [
    '6',
    'analytics.events_by_minute_mv',
    (_body: string) => "Cannot parse value 'analytics.events_by_minute_mv': While executing WaitForAsyncInsert.",
    false,
  ],
  // A real excerpt of the JSON body, with its escaped quotes, around the value.
  [
    '27',
    'media.final_mv',
    (body: string) => `Cannot parse input: before: '${excerpt(body, 'media.final_mv')}': While executing WaitForAsyncInsert.`,
    false,
  ],
  [
    '27',
    "it's logbird.events_mv",
    (body: string) => `Cannot parse input: before: '${excerpt(body, 'logbird.events_mv')}': While executing WaitForAsyncInsert.`,
    false,
  ],
  // The same name in failure context, absent from the body, still names a view.
  ['25', 'unrelated', (_body: string) => 'Parse failed in logbird.events_by_minute_mv: While executing WaitForAsyncInsert.', true],
  // A value in the body does not hide the same name used as unquoted failure context.
  ['25', 'logbird.events_by_minute_mv', (_body: string) => 'Parse failed in logbird.events_by_minute_mv: While executing WaitForAsyncInsert.', true],
  // A quoted value does not hide a different, real view name.
  [
    '25',
    'media.final_mv',
    (_body: string) => "Parse failed in logbird.event_ids_v3_mv near 'media.final_mv': While executing WaitForAsyncInsert.",
    true,
  ],
  // A quoted name that is not from our body (another body in the same flush, or a view) still counts.
  ['6', 'unrelated', (_body: string) => "Cannot parse value 'analytics.events_by_minute_mv': While executing WaitForAsyncInsert.", true],
])('classifies code %s with event value %j quoted in the error', async (code, value, render, ambiguous) => {
  const row = normalizeEvent({ id: 'quoted', action: 'qa.quoted', metadata: { source: value } }, { projectId: 'fictional', receivedAt: new Date() });
  if (!row.ok) throw new Error(row.reason);
  const message = render(`${JSON.stringify(row.row)}\n`);
  const error = Object.assign(new Error(message), { code });
  const exec = vi.fn(async (params: { values: AsyncIterable<unknown> }) => {
    for await (const _chunk of params.values) {
      /* send the body */
    }
    throw error;
  });
  const result = insertEvents({ exec } as unknown as ClickHouseClient, [row.row]);
  if (ambiguous) await expect(result).rejects.toBeInstanceOf(AmbiguousInsertError);
  else await expect(result).rejects.toBe(error);
  expect(isPrewriteParseError(error, `${JSON.stringify(row.row)}\n`)).toBe(!ambiguous);
});

it('knows every materialized view this package creates', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const sources = [
    ...readdirSync(join(root, 'migrations')).map((file) => join(root, 'migrations', file)),
    ...readdirSync(join(root, 'src'))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => join(root, 'src', file)),
  ];
  const created = new Set<string>();
  for (const file of sources) {
    for (const [, name] of readFileSync(file, 'utf8').matchAll(/CREATE MATERIALIZED VIEW (?:IF NOT EXISTS )?(\w+)\s+(?:TO|AS)\b/g))
      created.add(name!);
  }
  expect(created.size).toBeGreaterThan(0);
  expect([...created].sort()).toEqual([...LOGBIRD_MATERIALIZED_VIEWS].sort());
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
  expect(exec.mock.calls[0]?.[0]).toMatchObject({
    query: 'INSERT INTO events FORMAT JSONEachRow',
    clickhouse_settings: {
      ...INGEST_INSERT_SETTINGS,
      input_format_allow_errors_num: '0',
      input_format_allow_errors_ratio: 0,
    },
  });
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
    await expect(insertEvents({ exec } as unknown as ClickHouseClient, [n.row])).rejects.toBeInstanceOf(InsertLeaseExhaustedError);
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

it('throws a typed lease error before acquiring a socket', async () => {
  const n = normalizeEvent({ action: 'expired' }, { projectId: 'qa91', receivedAt: new Date() });
  if (!n.ok) throw new Error(n.reason);
  const exec = vi.fn();
  await expect(insertEvents({ exec } as unknown as ClickHouseClient, [n.row], Date.now() - 1)).rejects.toBeInstanceOf(InsertLeaseExhaustedError);
  expect(exec).not.toHaveBeenCalled();
});
it('sends a cached JSONEachRow body without serializing its rows again', async () => {
  const normalized = normalizeEvent({ id: 'qa91-cache', action: 'qa91.cache' }, { projectId: 'qa91-cache', receivedAt: new Date() });
  if (!normalized.ok) throw new Error(normalized.reason);
  const body = `${JSON.stringify(normalized.row)}\n`;
  const stringify = vi.spyOn(JSON, 'stringify');
  const chunks: Buffer[] = [];
  const exec = vi.fn(async (params: { values: Readable }) => {
    for await (const chunk of params.values) chunks.push(Buffer.from(chunk));
    return { stream: Readable.from([]) };
  });
  try {
    await insertEvents({ exec } as unknown as ClickHouseClient, [normalized.row], Date.now() + 60_000, body);
    expect(Buffer.concat(chunks).toString()).toBe(body);
    expect(stringify).not.toHaveBeenCalled();
  } finally {
    stringify.mockRestore();
  }
});

it('surfaces a lease lapse during real socket acquisition as InsertLeaseExhaustedError', async () => {
  // A throwaway local HTTP endpoint (no ClickHouse): proves the real @clickhouse/client rejects exec with the
  // stream's own error object, so isolation files the rows under the 'lease' limit, never as unavailable.
  const { createServer } = await import('node:http');
  const { createClickHouseClient } = await import('./client');
  let received = 0;
  const server = createServer((request, response) => {
    request.on('data', (chunk: Buffer) => {
      received += chunk.length;
    });
    request.on('end', () => response.end());
    request.on('error', () => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const ch = createClickHouseClient({ CLICKHOUSE_URL: `http://127.0.0.1:${address.port}`, CLICKHOUSE_USER: 'qa', CLICKHOUSE_PASSWORD: 'qa' });
  const n = normalizeEvent({ id: 'qa-lease-socket', action: 'qa.lease' }, { projectId: 'fictional', receivedAt: new Date() });
  if (!n.ok) throw new Error(n.reason);
  const realNow = Date.now.bind(Date);
  let shifted = false;
  // Time "passes" between exec() and the first body read: the lease is still valid at exec, lapsed at read().
  const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (shifted ? 61_000 : 0));
  try {
    const inserting = insertEvents(ch, [n.row], realNow() + 60_000);
    shifted = true;
    await expect(inserting).rejects.toBeInstanceOf(InsertLeaseExhaustedError);
    expect(received).toBe(0);
  } finally {
    now.mockRestore();
    await ch.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
