import { describe, expect, it } from 'vitest';
import { altClickLabel, detectMac, modKeyLabel } from './platform';

describe('platform labels', () => {
  it('detects Apple platforms only', () => {
    expect(detectMac({ platform: 'MacIntel' })).toBe(true);
    expect(detectMac({ platform: 'Win32' })).toBe(false);
    expect(detectMac({ platform: '', userAgentData: { platform: 'macOS' } })).toBe(true);
    expect(detectMac({ platform: 'Linux x86_64' })).toBe(false);
  });

  it('names the exclude modifier per platform', () => {
    expect(altClickLabel(false)).toBe('Alt-click');
    expect(altClickLabel(true)).toBe('⌥-click');
    expect(modKeyLabel(false, 'K')).toBe('Ctrl K');
    expect(modKeyLabel(true, 'K')).toBe('⌘K');
  });
});
