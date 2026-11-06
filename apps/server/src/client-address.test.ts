import { describe, expect, it } from 'vitest';
import { parseTrustedHops, pickClientAddress } from './client-address';

describe('pickClientAddress', () => {
  it('uses the socket peer without trusted hops, ignoring a spoofed header', () => {
    expect(pickClientAddress('6.6.6.6', '10.0.0.5', 0)).toBe('10.0.0.5');
  });
  it('console only (1 hop): the address the console appended, not client-sent entries', () => {
    expect(pickClientAddress('6.6.6.6, 203.0.113.7', '172.23.0.7', 1)).toBe('203.0.113.7');
  });
  it('reverse proxy + console (2 hops): the address the outer proxy appended', () => {
    // Caddy appends the browser, the console appends Caddy's container address.
    expect(pickClientAddress('6.6.6.6, 203.0.113.7, 172.23.0.9', '172.23.0.7', 2)).toBe('203.0.113.7');
  });
  it('fewer entries than hops: every entry is trusted, use the leftmost', () => {
    expect(pickClientAddress('203.0.113.7', '172.23.0.7', 2)).toBe('203.0.113.7');
  });
  it('falls back to the peer when the header is missing or empty', () => {
    expect(pickClientAddress(undefined, '172.23.0.7', 1)).toBe('172.23.0.7');
    expect(pickClientAddress(' , ', '172.23.0.7', 1)).toBe('172.23.0.7');
  });
});

describe('parseTrustedHops', () => {
  it.each([
    ['', 0],
    [undefined, 0],
    ['false', 0],
    ['0', 0],
    ['true', 1],
    ['TRUE', 1],
    ['2', 2],
  ])('%s → %d', (value, hops) => expect(parseTrustedHops(value)).toBe(hops));
  it('rejects anything else', () => expect(() => parseTrustedHops('yes')).toThrow());
});
