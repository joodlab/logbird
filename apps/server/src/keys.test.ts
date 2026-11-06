import { expect, it } from 'vitest';
import { generateApiKey, isApiKey } from './keys';

it('generates current keys and accepts stored legacy credentials of the requested kind', () => {
  for (const kind of ['ingest', 'read'] as const) {
    expect(generateApiKey(kind).secret.startsWith(`lb_${kind}_`)).toBe(true);
    for (const prefix of ['tm', 'lb']) {
      const secret = `${prefix}_${kind}_${'a'.repeat(32)}`;
      expect(isApiKey(secret, kind)).toBe(true);
      expect(isApiKey(secret, kind === 'read' ? 'ingest' : 'read')).toBe(false);
      expect(isApiKey(`${secret}!`, kind)).toBe(false);
    }
  }
});
