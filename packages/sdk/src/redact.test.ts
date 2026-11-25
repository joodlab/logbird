import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type EventInput, IDENTIFIER_FIELDS, Logbird, redact } from './index';
import { createAudit, jobAudit } from './integration';

it('redacts nested metadata, actor fields, arrays and change values without mutation', () => {
  const event = {
    id: 'token-id',
    action: 'password.changed',
    actor: { id: 'user', token: 'secret' },
    metadata: { nested: [{ api_key: 'secret', safe: 1 }] },
    changes: [
      { field: 'password', before: { value: 'secret' }, after: 'secret' },
      { field: 'name', after: 'safe' },
    ],
  };
  const original = structuredClone(event);
  expect(redact()(event)).toEqual({
    ...event,
    actor: { id: 'user', token: '[redacted]' },
    metadata: { nested: [{ api_key: '[redacted]', safe: 1 }] },
    changes: [
      { field: 'password', before: '[redacted]', after: '[redacted]' },
      { field: 'name', after: 'safe' },
    ],
  });
  expect(event).toEqual(original);
});

it('supports custom patterns including global regexes and never redacts identity', () => {
  const result = redact({ keys: /id|email/g, changeFields: /phone/g, replacement: 'hidden' })({
    id: 'id',
    action: 'action',
    actor: { id: 'u', email: 'fiction@example.test' },
    changes: [{ field: 'phone', after: '123' }],
  });
  expect(result).toMatchObject({
    id: 'id',
    action: 'action',
    // Identifier fields are structural and never redacted, as in the .NET SDK; the email is.
    actor: { id: 'u', email: 'hidden' },
    changes: [{ field: 'phone', after: 'hidden' }],
  });
  expect(result.changes?.[0]).not.toHaveProperty('before');
});

it('redacts an object reached twice as two copies, so an identity is never redacted through an alias', () => {
  const party = { type: 'user', id: 'user_1', name: 'Fictional User' };
  const event = { id: 'e', action: 'a', actor: party, metadata: { who: party } } as EventInput;
  const result = redact({ keys: /^(who|id|type)$/ })(event) as unknown as Record<string, Record<string, unknown>>;
  expect(result.actor).toEqual({ type: 'user', id: 'user_1', name: 'Fictional User' });
  expect(result.metadata).toEqual({ who: '[redacted]' });
  const nested = redact({ keys: /^name$/ })(event) as unknown as { actor: unknown; metadata: { who: unknown } };
  expect(nested.actor).toEqual({ type: 'user', id: 'user_1', name: '[redacted]' });
  expect(nested.metadata.who).toEqual({ type: 'user', id: 'user_1', name: '[redacted]' });
  expect(nested.actor).not.toBe(nested.metadata.who);
  expect(party.name).toBe('Fictional User');
});

it('throws for an event with a cycle, as sending it would, instead of redacting forever', () => {
  const metadata: Record<string, unknown> = { plan: 'pro' };
  metadata.self = metadata;
  expect(() => redact()({ id: 'e', action: 'a', metadata } as EventInput)).toThrow(TypeError);
});

it('returns the event as JSON sends it', () => {
  const at = new Date('2026-11-24T00:00:00.000Z');
  const result = redact()({ id: 'e', action: 'a', occurredAt: at, metadata: { skip: undefined } } as unknown as EventInput);
  expect(result).toStrictEqual({ id: 'e', action: 'a', occurredAt: '2026-11-24T00:00:00.000Z', metadata: {} });
});

it('replaces a matched value without reading it, so a value JSON cannot hold never stops the event', () => {
  const event = { id: 'e', action: 'probe', metadata: { token: 1n, nested: { apiKey: Symbol('x') } } } as unknown as EventInput;
  const result = redact()(event);
  // A value JSON leaves out (a symbol) is left out, matched or not, as the JSON the .NET SDK redacts would not hold it.
  expect(JSON.stringify(result)).toBe('{"id":"e","action":"probe","metadata":{"token":"[redacted]","nested":{}}}');
});

it('keeps key order and writes exactly what JSON.stringify would for what it keeps', () => {
  const event = {
    action: 'a',
    id: 'e',
    metadata: { b: 1, a: undefined, c: () => 1, d: [undefined, () => 1, 2], when: new Date('2026-11-24T00:00:00.000Z'), z: 'last' },
  } as unknown as EventInput;
  const result = redact({ keys: /^never$/ })(event);
  expect(JSON.stringify(result)).toBe(JSON.stringify(event));
  expect(Object.keys((result as unknown as { metadata: object }).metadata)).toEqual(['b', 'd', 'when', 'z']);
});

it('decides changes and parties on what toJSON returns, as sending does', () => {
  const event = {
    id: 'e',
    action: 'a',
    actor: { toJSON: () => ({ type: 'user', id: 'user_1', name: 'Fictional User' }) },
    changes: [{ toJSON: () => ({ field: 'token', before: 'visible', after: 'also visible' }) }],
  } as unknown as EventInput;
  expect(JSON.stringify(redact({ keys: /actor|token/ })(event))).toBe(
    '{"id":"e","action":"a","actor":{"type":"user","id":"user_1","name":"[redacted]"},"changes":[{"field":"token","before":"[redacted]","after":"[redacted]"}]}',
  );
});

it('reads every value exactly as sending it reads it', () => {
  const make = () => {
    let x = 0;
    return {
      id: 'e',
      action: 'a',
      metadata: {
        a: {
          get v() {
            x += 1;
            return x;
          },
        },
        get b() {
          return x;
        },
      },
    } as unknown as EventInput;
  };
  expect(JSON.stringify(redact({ keys: /^never$/ })(make()))).toBe(JSON.stringify(make()));

  // A change whose field is a getter: it runs once, and the change is still redacted.
  let reads = 0;
  const change = {
    get field() {
      reads += 1;
      return 'password';
    },
    after: 'secret',
  };
  const result = redact()({ id: 'e', action: 'a', changes: [change] } as unknown as EventInput);
  expect(reads).toBe(1);
  expect(JSON.stringify(result)).toBe('{"id":"e","action":"a","changes":[{"field":"password","after":"[redacted]"}]}');
});

it('keeps a literal __proto__ key and unwraps boxed primitives, as JSON does', () => {
  const metadata = JSON.parse('{"__proto__":5,"n":0}') as Record<string, unknown>;
  metadata.n = new Object(7);
  const result = redact({ keys: /^never$/ })({ id: 'e', action: 'a', metadata } as unknown as EventInput);
  expect(JSON.stringify(result)).toBe('{"id":"e","action":"a","metadata":{"__proto__":5,"n":7}}');
  expect(Object.hasOwn((result as unknown as { metadata: object }).metadata, '__proto__')).toBe(true);
  const hidden = redact()({ id: 'e', action: 'a', metadata: { token: new Object(7) } } as unknown as EventInput);
  expect(JSON.stringify(hidden)).toBe('{"id":"e","action":"a","metadata":{"token":"[redacted]"}}');
});

it('tells a boxed primitive as JSON does, by its internal slot, so nothing escapes redaction', async () => {
  const { runInNewContext } = await import('node:vm');
  // An object with Number.prototype is an ordinary object to JSON: its own keys are redacted.
  const numberLike = Object.assign(Object.create(Number.prototype), { secret: 'visible' });
  expect(JSON.stringify(redact()({ id: 'e', action: 'a', metadata: numberLike } as unknown as EventInput))).toBe(
    '{"id":"e","action":"a","metadata":{"secret":"[redacted]"}}',
  );
  // A boxed number from another realm is a scalar to JSON: a matched party holding one is replaced.
  const foreign = runInNewContext('new Number(7)') as object;
  expect(JSON.stringify(redact({ keys: /actor/ })({ id: 'e', action: 'a', actor: foreign } as unknown as EventInput))).toBe(
    '{"id":"e","action":"a","actor":"[redacted]"}',
  );
});

// TypeScript only, kept out of the shared fixture: these shapes cannot be written as JSON, so the .NET SDK never sees
// them. A change whose field is not a plain own string fails closed (the master's ruling on #345).
describe('a change whose field JSON cannot tell fails closed', () => {
  const values = (change: object) => {
    const result = redact({ keys: /^never$/, changeFields: /^password$/ })({ id: 'e', action: 'a', changes: [change] } as unknown as EventInput);
    const entry = (result as unknown as { changes: Array<Record<string, unknown>> }).changes[0]!;
    return [entry.before, entry.after];
  };
  const redacted = ['[redacted]', '[redacted]'];

  it('redacts a getter field, without reading it', () => {
    let reads = 0;
    const change = {
      get field() {
        reads += 1;
        return 'public';
      },
      before: 'b',
      after: 'a',
    };
    expect(values(change)).toEqual(redacted);
    expect(reads).toBe(1);
  });

  it('redacts an inherited field', () => {
    expect(values(Object.assign(Object.create({ field: 'public' }), { before: 'b', after: 'a' }))).toEqual(redacted);
  });

  it('redacts a non-enumerable field', () => {
    const change = { before: 'b', after: 'a' };
    Object.defineProperty(change, 'field', { value: 'public', enumerable: false });
    expect(values(change)).toEqual(redacted);
  });

  it('redacts a field whose value has a toJSON, an object or a function', () => {
    expect(values({ field: { toJSON: () => 'public' }, before: 'b', after: 'a' })).toEqual(redacted);
    const callable = Object.assign(() => 'unused', { toJSON: () => 'password' });
    expect(values({ field: callable, before: 1, after: 2 })).toEqual(redacted);
  });

  it('keeps the shared rule for a plain own field', () => {
    expect(values({ field: 'public', before: 'b', after: 'a' })).toEqual(['b', 'a']);
    expect(values({ field: 'password', before: 'b', after: 'a' })).toEqual(redacted);
    expect(values({ field: 7, before: 'b', after: 'a' })).toEqual(['b', 'a']);
    expect(values({ before: 'b', after: 'a' })).toEqual(['b', 'a']);
  });
});

it('lists the same identifier fields as the .NET SDK', () => {
  expect(IDENTIFIER_FIELDS).toEqual([
    'actor.type',
    'actor.id',
    'impersonator.id',
    'executor.type',
    'executor.id',
    'executor.jobId',
    'executor.attempt',
    'tenant.id',
    'targets[].type',
    'targets[].id',
  ]);
  expect(Object.isFrozen(IDENTIFIER_FIELDS)).toBe(true);
});

type ParityCase = {
  name: string;
  keys: string | null;
  changeFields: string | null;
  replacement: string | null;
  addKeys?: string[];
  paths?: string[];
  keepPaths?: string[];
  input: EventInput;
  expected: unknown;
};

// The same cases run in the .NET SDK (RedactionParityTests): both must produce exactly the expected event.
const fixture = JSON.parse(
  readFileSync(new URL('../../../sdks/dotnet/tests/Logbird.Tests/Fixtures/redaction-parity.json', import.meta.url), 'utf8'),
) as { cases: ParityCase[] };

const connection = { endpoint: 'https://capture.example.invalid', apiKey: 'fictional' };

function capture() {
  const events: EventInput[] = [];
  const send = vi.fn((_url: string, request: RequestInit) => {
    const batch = (JSON.parse(request.body as string) as { events: EventInput[] }).events;
    events.push(...batch);
    return Promise.resolve(Response.json({ accepted: batch.length, ids: batch.map((event) => event.id), rejected: [] }, { status: 202 }));
  });
  vi.stubGlobal('fetch', send);
  return { events, send };
}

afterEach(() => vi.unstubAllGlobals());

it.each(fixture.cases)('parity: $name', async ({ keys, changeFields, replacement, input, expected, addKeys, paths, keepPaths }) => {
  const options = {
    addKeys,
    paths,
    keepPaths,
    ...(keys === null ? {} : { keys: new RegExp(keys) }),
    ...(changeFields === null ? {} : { changeFields: new RegExp(changeFields) }),
    ...(replacement === null ? {} : { replacement }),
  };
  const original = structuredClone(input);
  expect(redact(options)(input)).toStrictEqual(expected);
  const { events } = capture();
  // Use the exact fixture as the hook result so defaults, empty metadata/context and a generated timestamp
  // cannot affect the comparison.
  const client = new Logbird({ ...connection, redaction: options, beforeSend: () => input });
  client.track(input);
  await client.shutdown();
  expect(events).toStrictEqual([expected]);
  expect(input).toStrictEqual(original);
});

it('runs the hook before default redaction and checks the final serialized size', async () => {
  const { events } = capture();
  const onError = vi.fn();
  const onDrop = vi.fn();
  const token = 'x'.repeat(300 * 1024);
  const beforeSend = vi.fn((event: EventInput) =>
    event.action === 'keep' ? { ...event, actor: { id: 'staff', token }, metadata: { ...event.metadata, authorization: token } } : event,
  );
  const client = new Logbird({ ...connection, beforeSend, onError, onDrop, defaults: { metadata: { password: token } } });
  client.track({ action: 'keep', metadata: { token } });
  client.track({ action: 'oversize', metadata: { safe: token } });
  await client.shutdown();
  expect(beforeSend.mock.calls[0]?.[0].metadata?.token).toBe(token);
  expect(events).toMatchObject([
    {
      action: 'keep',
      actor: { id: 'staff', token: '[redacted]' },
      metadata: { password: '[redacted]', token: '[redacted]', authorization: '[redacted]' },
    },
  ]);
  expect(onError).toHaveBeenCalledOnce();
  expect(onError.mock.calls[0]?.[0].message).toMatch(/256/);
});

it('allows opting out and composing the helper with client options', async () => {
  const { events } = capture();
  const disabled = new Logbird({ ...connection, redaction: false });
  const composed = new Logbird({
    ...connection,
    beforeSend: redact({ keys: /^notes$/, replacement: 'hidden by hook', paths: ['metadata.phone'] }),
    redaction: { addKeys: ['email'] },
  });
  const event = { action: 'a', metadata: { password: 'fictional secret', notes: 'fictional notes', phone: '123', email: 'guest@example.invalid' } };
  disabled.track(event);
  composed.track(event);
  await disabled.shutdown();
  await composed.shutdown();
  expect(events[0]?.metadata).toEqual(event.metadata);
  expect(events[1]?.metadata).toEqual({ password: '[redacted]', notes: 'hidden by hook', phone: 'hidden by hook', email: '[redacted]' });
});

it.each(['', '.private', 'private.', 'private..value', 'private.**', 'private.pre*', 'private.\\q', 'private.\\'])(
  'rejects invalid path entry %j at construction',
  (path) => {
    for (const option of ['paths', 'keepPaths'] as const) {
      const redaction = { [option]: ['metadata.valid', path] };
      const message = `Invalid redaction ${option} entry at index 1`;
      expect(() => new Logbird({ ...connection, redaction })).toThrow(message);
      expect(() => redact(redaction)).toThrow(message);
    }
  },
);

it('reports identifier matches once at startup, then ignores them', async () => {
  const { events } = capture();
  const onError = vi.fn(() => {
    throw new Error('diagnostic failed');
  });
  const client = new Logbird({
    ...connection,
    onError,
    redaction: {
      keys: /^(id|type)$/,
      addKeys: ['jobid'],
      paths: ['id', 'action', '*.id', 'targets.0.type', 'targets.*.id'],
    },
  });
  expect(onError).toHaveBeenCalledOnce();
  expect(onError.mock.calls[0]).toEqual([expect.objectContaining({ message: expect.stringMatching(/actor\.id.*targets\[\]\.type.*jobId/) })]);
  const event = {
    action: 'a',
    id: 'keep',
    actor: { id: 'staff', type: 'user' },
    executor: { jobId: 42 },
    targets: [{ id: 'record', type: 'record' }],
    metadata: { id: 'private', jobId: 'private', type: 'private' },
  };
  client.track(event);
  await client.shutdown();
  expect(events).toMatchObject([{ ...event, metadata: { id: '[redacted]', jobId: '[redacted]', type: '[redacted]' } }]);
  expect(onError).toHaveBeenCalledOnce();
});

it('refuses unredactable events, counts them, and keeps recording without leaking through diagnostics', async () => {
  const { events } = capture();
  const onDrop = vi.fn();
  const onError = vi.fn();
  const client = new Logbird({ ...connection, onDrop, onError, redaction: { paths: ['metadata.guest.email'] } });
  const cycle: { self?: object } = {};
  cycle.self = cycle;
  client.track({ id: 'cycle', action: 'a', metadata: { cycle, token: 'fictional secret' } });
  client.track({
    id: 'throwing',
    action: 'a',
    metadata: {
      guest: {
        toJSON: () => {
          throw new Error('fictional secret');
        },
      },
    },
  });
  client.track({ id: 'bad-json', action: 'a', toJSON: () => 'fictional secret' });
  client.track({ id: 'safe', action: 'a', metadata: { guest: { toJSON: () => ({ email: 'guest@example.invalid' }) } } });
  await client.shutdown();
  expect(events).toMatchObject([{ id: 'safe', metadata: { guest: { email: '[redacted]' } } }]);
  expect(client.dropped).toBe(3);
  expect(onDrop.mock.calls).toEqual(['cycle', 'throwing', 'bad-json'].map((id) => [{ id, action: 'a' }]));
  expect(onError).toHaveBeenCalledTimes(3);
  for (const [error] of onError.mock.calls) {
    expect(error.message).toBe('An audit event could not be redacted and was dropped');
  }
});

it('applies client redaction to the default host and BullMQ job audit entry points', async () => {
  const { events } = capture();
  const client = new Logbird({ ...connection, redaction: { addKeys: ['email'], keepPaths: ['actor.email'] } });
  const audit = await createAudit({ client, actor: () => ({ id: 'staff', email: 'staff@example.invalid' }) }, {}, new Request(connection.endpoint));
  audit('request', { metadata: { email: 'guest@example.invalid' } });
  const job = jobAudit({ client, job: { id: 42, name: 'process', queueName: 'audit' }, carrier: await audit.carrier() });
  job('job', { metadata: { email: 'guest@example.invalid', token: 'fictional secret' } });
  await Promise.all([audit.pending(), job.pending()]);
  await client.shutdown();
  expect(events).toMatchObject([
    { action: 'request', actor: { id: 'staff', email: 'staff@example.invalid' }, metadata: { email: '[redacted]' } },
    {
      action: 'job',
      actor: { id: 'staff', email: 'staff@example.invalid' },
      executor: { jobId: '42' },
      metadata: { email: '[redacted]', token: '[redacted]' },
    },
  ]);
});
