import { expect, it } from 'vitest';
import { redact } from './index';

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
it('supports custom patterns including global regexes and protects top-level identity', () => {
  const result = redact({ keys: /id|email/g, changeFields: /phone/g, replacement: 'hidden' })({
    id: 'id',
    action: 'action',
    actor: { id: 'u', email: 'fiction@example.test' },
    changes: [{ field: 'phone', after: '123' }],
  });
  expect(result).toMatchObject({
    id: 'id',
    action: 'action',
    actor: { id: 'hidden', email: 'hidden' },
    changes: [{ field: 'phone', after: 'hidden' }],
  });
  expect(result.changes?.[0]).not.toHaveProperty('before');
});
