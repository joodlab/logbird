/**
 * Nitro (server/proxy.ts) must be the only path from the console to the API in dev too. Vite's `server.proxy` matches
 * raw prefixes and normalizes dot segments, so a fallback there would bypass proxyDecision() for requests Nitro's dev
 * pre-middleware hands to Vite (for example `Sec-Fetch-Dest: image` asset fetches to `/api/../docs`).
 */
import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('dev server config', () => {
  it('has no Vite proxy', async () => {
    const resolved = typeof config === 'function' ? await config({ command: 'serve', mode: 'development' }) : await config;
    expect(resolved.server?.port).toBe(4600);
    expect(resolved.server?.proxy).toBeUndefined();
    expect(resolved.preview?.proxy).toBeUndefined();
  });
});
