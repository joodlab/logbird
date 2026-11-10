import { siteConfig } from '../env';
import type { WaitlistRecord } from '../lib/waitlist-schema';
/** Enable a KV namespace named WAITLIST_KV in wrangler.jsonc to opt in to storage. */
export interface WaitlistBindings {
  WAITLIST_KV?: { put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> };
}

/** Seconds from `now` until the same moment `months` calendar months later: how long KV keeps a submission. */
export function retentionSeconds(now: number, months: number) {
  const until = new Date(now);
  until.setUTCMonth(until.getUTCMonth() + months);
  return Math.ceil((until.getTime() - now) / 1000);
}

export function createCloudflareStore(bindings: WaitlistBindings, months = siteConfig.FORM_RETENTION_MONTHS) {
  return async (record: WaitlistRecord) => {
    if (!bindings.WAITLIST_KV) {
      throw new Error('WAITLIST_KV is not configured');
    }
    // KV deletes the record itself once the privacy policy's retention period has passed (#132).
    await bindings.WAITLIST_KV.put(`waitlist:${record.receivedAt}:${crypto.randomUUID()}`, JSON.stringify(record), {
      expirationTtl: retentionSeconds(Date.parse(record.receivedAt), months),
    });
  };
}
