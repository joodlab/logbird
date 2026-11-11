import { resolve } from 'node:path';
import { definePlugin } from 'nitro';

/**
 * Starts the form-submission retention cleanup (src/server/waitlist-retention.ts), only in a production Node server
 * whose submissions store is configured explicitly: the site image sets WAITLIST_FILE at runtime. vite.config.ts
 * registers this plugin for the Node build only (Cloudflare stores submissions in KV with an expiry instead). Never in
 * `vite dev`, never while the build prerenders pages (TanStack Start prerenders through this same Node server and marks
 * it with TSS_PRERENDERING=true; Nitro's own prerender preset sets import.meta.prerender), and never for the source
 * default (apps/web/.data). The timers stop when the server closes.
 */
export default definePlugin((nitroApp) => {
  if (import.meta.dev || import.meta.prerender || process.env.TSS_PRERENDERING === 'true') {
    return;
  }
  // Exactly the value the writers and admin.mjs use (no trimming), so all of them reach the same store.
  const configured = process.env.WAITLIST_FILE;
  if (!configured?.trim() || process.env.NODE_ENV !== 'production') {
    return;
  }
  const started = import('../../src/server/waitlist-retention')
    .then(({ scheduleWaitlistRetention }) => scheduleWaitlistRetention(resolve(configured)))
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({ level: 'error', event: 'waitlist.retention_failed', reason: error instanceof Error ? error.message : 'unknown' }),
      );
    });
  nitroApp.hooks.hook('close', async () => {
    (await started)?.();
  });
});
