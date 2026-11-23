import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { type EventInput, IDENTIFIER_FIELDS, redact } from './index';

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
  input: EventInput;
  expected: unknown;
};

// The same cases run in the .NET SDK (RedactionParityTests): both must produce exactly the expected event.
const fixture = JSON.parse(
  readFileSync(new URL('../../../sdks/dotnet/tests/Logbird.Tests/Fixtures/redaction-parity.json', import.meta.url), 'utf8'),
) as { cases: ParityCase[] };

it.each(fixture.cases)('parity: $name', ({ keys, changeFields, replacement, input, expected }) => {
  const options = {
    ...(keys === null ? {} : { keys: new RegExp(keys) }),
    ...(changeFields === null ? {} : { changeFields: new RegExp(changeFields) }),
    ...(replacement === null ? {} : { replacement }),
  };
  const original = structuredClone(input);
  expect(redact(options)(input)).toStrictEqual(expected);
  expect(input).toStrictEqual(original);
});
