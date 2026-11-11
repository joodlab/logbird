import { resolve } from 'node:path';
import { definePlugin } from 'nitro';

/**
 * Starts the form-submission retention cleanup (src/server/waitlist-retention.ts), only in a production Node server
 * whose submissions file is configured explicitly: the site image sets WAITLIST_FILE at runtime. vite.config.ts
 * registers this plugin for the Node build only (Cloudflare stores submissions in KV with an expiry instead). Never in
 * `vite dev`, never while the build prerenders pages (TanStack Start prerenders through this same Node server and marks
 * it with TSS_PRERENDERING=true; Nitro's own prerender preset sets import.meta.prerender), and never for the source
 * default (apps/web/.data). The timers stop when the server closes.
 */
export default definePlugin((nitroApp) => {
  if (import.meta.dev || import.meta.prerender || process.env.TSS_PRERENDERING === 'true') {
    return;
  }
  const configured = process.env.WAITLIST_FILE?.trim();
  if (!configured || process.env.NODE_ENV !== 'production') {
    return;
  }
  const file = resolve(configured);
  // Announce this container as a writer first, so another container sharing the volume (during a deploy) holds off
  // its cleanup, and this one holds off while that one is still running (waitlist/file.mjs).
  const started = Promise.all([import('../../waitlist/file.mjs'), import('../../src/server/waitlist-retention')])
    .then(async ([{ registerWaitlistWriter }, { scheduleWaitlistRetention }]) => {
      const unregister = await registerWaitlistWriter(file);
      const stop = scheduleWaitlistRetention(file);
      return async () => {
        stop();
        await unregister();
      };
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({ level: 'error', event: 'waitlist.retention_failed', reason: error instanceof Error ? error.message : 'unknown' }),
      );
    });
  nitroApp.hooks.hook('close', async () => {
    await (await started)?.();
  });
});
