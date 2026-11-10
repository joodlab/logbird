import { pruneWaitlist } from '../../waitlist/file.mjs';
import { siteConfig } from '../env';

/**
 * Automated retention for form submissions (#132). The privacy policy says how long the site keeps a submission
 * (WEB_FORM_RETENTION_MONTHS, default 24); this deletes older ones from the Node server's JSONL file. It runs when the
 * server starts and then every few hours (server/plugins/form-retention.ts). The Cloudflare build gives each KV record
 * the same lifetime instead (waitlist-cloudflare.ts).
 */
export const WAITLIST_SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

/** Deletes submissions older than the retention period and logs counts only (never a record). */
export async function sweepWaitlist(
  file: string,
  options: { now?: number; months?: number; log?: (line: string) => void } = {},
): Promise<{ kept: number; removed: number }> {
  const months = options.months ?? siteConfig.FORM_RETENTION_MONTHS;
  const log = options.log ?? ((line: string) => console.log(line));
  const result = await pruneWaitlist(file, options.now ?? Date.now(), months);
  if (result.removed) {
    log(JSON.stringify({ level: 'info', event: 'waitlist.retention', removed: result.removed, kept: result.kept, months }));
  }
  return result;
}

/** Sweeps now and on an interval that never keeps the process alive. A failed sweep logs and the next one retries. */
export function scheduleWaitlistRetention(file: string, log: (line: string) => void = (line) => console.error(line)) {
  const run = () =>
    sweepWaitlist(file).catch((error: unknown) => {
      log(JSON.stringify({ level: 'error', event: 'waitlist.retention_failed', reason: error instanceof Error ? error.message : 'unknown' }));
    });
  void run();
  const timer = setInterval(run, WAITLIST_SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
