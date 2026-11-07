import { describe, expect, it } from 'vitest';
import { explorerResultKey } from './explorer';

describe('explorerResultKey', () => {
  it('changes between two entity profiles even when the typed query stays empty', () => {
    // Entity pages pass a baseQuery; q is '' on both, so only the effective query differs.
    expect(explorerResultKey('p1', '24h', 'actor:"a"', 'query')).not.toBe(explorerResultKey('p1', '24h', 'actor:"b"', 'query'));
  });

  it('changes when only the project changes', () => {
    expect(explorerResultKey('p1', '24h', '', 'query')).not.toBe(explorerResultKey('p2', '24h', '', 'query'));
  });

  it('changes with the range and, when there is a query, with the language', () => {
    expect(explorerResultKey('p1', '24h', 'x', 'query')).not.toBe(explorerResultKey('p1', '7d', 'x', 'query'));
    expect(explorerResultKey('p1', '24h', 'x', 'query')).not.toBe(explorerResultKey('p1', '24h', 'x', 'sql'));
  });

  it('ignores the language when there is no query to parse', () => {
    expect(explorerResultKey('p1', '24h', '', 'query')).toBe(explorerResultKey('p1', '24h', '', 'sql'));
  });
});
