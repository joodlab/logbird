import { definePlugin } from 'nitro';

/**
 * Starts the form-submission retention cleanup (src/server/waitlist-retention.ts), only in a production Node server
 * whose submissions file is configured explicitly: the site image sets WAITLIST_FILE at runtime. Never in `vite dev`,
 * never while the build prerenders pages, never for the source default (apps/web/.data), and never on Cloudflare,
 * which stores submissions in KV with an expiry instead. The timer stops when the server closes.
 */
export default definePlugin((nitroApp) => {
  if (import.meta.dev || import.meta.prerender || import.meta.env.NITRO_PRESET === 'cloudflare-module') {
    return;
  }
  const configured = process.env.WAITLIST_FILE?.trim();
  if (!configured || process.env.NODE_ENV !== 'production') {
    return;
  }
  const started = (async () => {
    const [{ waitlistFile }, { scheduleWaitlistRetention }] = await Promise.all([
      import('../../src/server/waitlist-node'),
      import('../../src/server/waitlist-retention'),
    ]);
    const file = waitlistFile(configured);
    return file ? scheduleWaitlistRetention(file) : undefined;
  })().catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'error', event: 'waitlist.retention_failed', reason: error instanceof Error ? error.message : 'unknown' }));
  });
  nitroApp.hooks.hook('close', async () => {
    (await started)?.();
  });
});
