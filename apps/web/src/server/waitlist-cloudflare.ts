import type { WaitlistRecord } from '../lib/waitlist-schema';
/** Enable a KV namespace named WAITLIST_KV in wrangler.jsonc to opt in to storage. */
export interface WaitlistBindings {
  WAITLIST_KV?: { put(key: string, value: string): Promise<void> };
}
export function createCloudflareStore(bindings: WaitlistBindings) {
  return async (record: WaitlistRecord) => {
    if (!bindings.WAITLIST_KV) {
      throw new Error('WAITLIST_KV is not configured');
    }
    await bindings.WAITLIST_KV.put(`waitlist:${record.receivedAt}:${crypto.randomUUID()}`, JSON.stringify(record));
  };
}
