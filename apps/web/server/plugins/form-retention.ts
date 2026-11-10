import { definePlugin } from 'nitro';

/**
 * Starts the form-submission retention cleanup in the Node server (src/server/waitlist-retention.ts). The Cloudflare
 * build stores submissions in KV with an expiry instead, so it has nothing to sweep.
 */
export default definePlugin(() => {
  if (import.meta.env.NITRO_PRESET === 'cloudflare-module') {
    return;
  }
  void (async () => {
    const [{ waitlistFile }, { serverEnv }, { scheduleWaitlistRetention }] = await Promise.all([
      import('../../src/server/waitlist-node'),
      import('../../src/server/env'),
      import('../../src/server/waitlist-retention'),
    ]);
    const file = waitlistFile(serverEnv.WAITLIST_FILE);
    if (file) {
      scheduleWaitlistRetention(file);
    }
  })().catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'error', event: 'waitlist.retention_failed', reason: error instanceof Error ? error.message : 'unknown' }));
  });
});
