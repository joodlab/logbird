// No imports: the Cloudflare Worker bundle uses this too, and it has no file system or sockets.

/**
 * When a submission received at `receivedAt` (ms) expires: the same day and time `months` calendar months later, or
 * the last day of that month when it is shorter (31 January + 1 month is 28 or 29 February). The Node cleanup and
 * the Cloudflare KV expiry both use this rule. The Node cleanup deletes a record on its first run after this moment
 * (it runs every six hours); KV removes it on its own schedule after the expiry.
 */
export function retentionExpiry(receivedAt, months) {
  const start = new Date(receivedAt);
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  target.setUTCHours(start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds());
  return target.getTime();
}
