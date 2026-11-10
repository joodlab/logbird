import { retentionExpiry } from '../../waitlist/expiry.mjs';
import { siteConfig } from '../env';
import type { WaitlistRecord } from '../lib/waitlist-schema';
/** Enable a KV namespace named WAITLIST_KV in wrangler.jsonc to opt in to storage. */
export interface WaitlistBindings {
  WAITLIST_KV?: { put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> };
}

/** Seconds until a submission received at `receivedAt` expires (the same calendar rule as the Node cleanup). */
export function retentionSeconds(receivedAt: number, months: number) {
  return Math.ceil((retentionExpiry(receivedAt, months) - receivedAt) / 1000);
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
