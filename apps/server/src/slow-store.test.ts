import { afterEach, describe, expect, it, vi } from 'vitest';
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

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('scales slowStore and purgeLimit by the factor read at load: unchanged when off, six times when on', async () => {
    vi.stubEnv('LOGBIRD_TEST_SLOW_STORE', undefined);
    vi.resetModules();
    const off = await import('./slow-store');
    expect(off.slowStore(30_000)).toBe(30_000);
    expect(off.purgeLimit(90_000)).toEqual({ timeout: 90_000 });
    vi.stubEnv('LOGBIRD_TEST_SLOW_STORE', '1');
    vi.resetModules();
    const on = await import('./slow-store');
    expect(on.slowStore(30_000)).toBe(180_000);
    expect(on.purgeLimit(90_000)).toEqual({ timeout: 540_000 });
  });
});
