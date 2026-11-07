import { defineEventHandler } from 'nitro/h3';
import { SITE_URL } from '../src/env';
import { createRateLimiter, handleWaitlist } from '../src/server/waitlist';
import { createCloudflareStore, type WaitlistBindings } from '../src/server/waitlist-cloudflare';

const limiter = createRateLimiter();
export default defineEventHandler(async (event) => {
  const request = event.req;
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }
  const cloudflare = event.req.runtime?.cloudflare as { env: WaitlistBindings } | undefined;
  let store: Parameters<typeof handleWaitlist>[1]['store'];
  if (cloudflare || import.meta.env.NITRO_PRESET === 'cloudflare-module') {
    store = createCloudflareStore(cloudflare?.env ?? {});
  } else {
    const { resolve } = await import('node:path');
    const { createNodeStore, notifyWaitlist } = await import('../src/server/waitlist-node');
    const { serverEnv: env } = await import('../src/server/env');
    store = createNodeStore(resolve('.data/waitlist.jsonl'), env.SMTP_HOST ? notifyWaitlist : undefined);
  }
  return handleWaitlist(request, {
    store,
    limiter,
    ip: cloudflare ? (request.headers.get('cf-connecting-ip') ?? 'unknown') : (event.req.ip ?? 'unknown'),
    allowedOrigin: cloudflare ? new URL(SITE_URL).origin : new URL(request.url).origin,
  });
});
