import { describe, expect, it } from 'vitest';
import { slowStoreFactor } from './slow-store';

describe('LOGBIRD_TEST_SLOW_STORE', () => {
  it('keeps the committed limits unless it is set to 1', () => {
    expect(slowStoreFactor(undefined)).toBe(1);
    expect(slowStoreFactor('0')).toBe(1);
    expect(slowStoreFactor('1')).toBe(6);
  });

  it('refuses any other value, empty included, instead of silently running with the committed limits', () => {
    for (const value of ['', ' ', ' 1', '0 ', 'true', 'yes', '2', '6', 'on']) expect(() => slowStoreFactor(value)).toThrow(/LOGBIRD_TEST_SLOW_STORE/);
  });
});
