import { pruneWaitlist, type WaitlistRewrite } from '../../waitlist/file.mjs';
import { siteConfig } from '../env';

/**
 * Automated retention for form submissions (#132). The privacy policy says how long the site keeps a submission
 * (WEB_FORM_RETENTION_MONTHS, default 24); this deletes older ones from the Node server's JSONL file, ten minutes
 * after the server starts and then every six hours (server/plugins/form-retention.ts). The Cloudflare build gives each
 * KV record the same lifetime instead (waitlist-cloudflare.ts).
 *
 * The lock that keeps writers apart works inside one container (one network namespace). The first sweep waits ten
 * minutes so that during a rolling deploy, when a new site container starts beside the old one on the same volume,
 * the old one has stopped before the new one rewrites the file. Run one site container per volume (docs/coolify.md).
 */
export const WAITLIST_FIRST_SWEEP_MS = 10 * 60 * 1000;
export const WAITLIST_SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Deletes submissions whose retention period has ended and logs counts only (never a record): an `info` line when it
 * removed some, a `warn` line while the file has lines it can't read (those are kept, so they need an operator).
 */
export async function sweepWaitlist(
  file: string,
  options: { now?: number; months?: number; log?: (line: string) => void } = {},
): Promise<WaitlistRewrite> {
  const months = options.months ?? siteConfig.FORM_RETENTION_MONTHS;
  const log = options.log ?? ((line: string) => console.log(line));
  const result = await pruneWaitlist(file, options.now ?? Date.now(), months);
  if (result.removed || result.unreadable) {
    log(
      JSON.stringify({
        level: result.unreadable ? 'warn' : 'info',
        event: 'waitlist.retention',
        removed: result.removed,
        kept: result.kept,
        unreadable: result.unreadable,
        months,
      }),
    );
  }
  return result;
}

/** Sweeps after a delay and then on an interval; timers never keep the process alive. A failed sweep logs and retries. */
export function scheduleWaitlistRetention(file: string, options: { firstAfterMs?: number; log?: (line: string) => void } = {}) {
  const log = options.log ?? ((line: string) => console.error(line));
  const run = () =>
    sweepWaitlist(file).catch((error: unknown) => {
      log(JSON.stringify({ level: 'error', event: 'waitlist.retention_failed', reason: error instanceof Error ? error.message : 'unknown' }));
    });
  let interval: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    void run();
    interval = setInterval(run, WAITLIST_SWEEP_EVERY_MS);
    interval.unref();
  }, options.firstAfterMs ?? WAITLIST_FIRST_SWEEP_MS);
  first.unref();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}
