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
    const { createNodeStore, notifyWaitlist, waitlistFile } = await import('../src/server/waitlist-node');
    const { serverEnv: env } = await import('../src/server/env');
    const file = waitlistFile(env.WAITLIST_FILE);
    if (!file) {
      return Response.json(
        { error: { code: 'waitlist_unavailable', message: 'Set WAITLIST_FILE, or start the site from apps/web.' } },
        { status: 503 },
      );
    }
    store = createNodeStore(file, env.SMTP_HOST ? notifyWaitlist : undefined);
  }
  const extra = cloudflare
    ? []
    : ((await import('../src/server/env')).serverEnv.WEB_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
  // The site's own origin always; the request's origin only in local development (a TLS proxy changes the scheme).
  const allowedOrigins = [
    new URL(SITE_URL).origin,
    ...extra,
    ...(!cloudflare && process.env.NODE_ENV !== 'production' ? [new URL(request.url).origin] : []),
  ];
  return handleWaitlist(request, {
    store,
    limiter,
    ip: cloudflare ? (request.headers.get('cf-connecting-ip') ?? 'unknown') : (event.req.ip ?? 'unknown'),
    allowedOrigins,
  });
});
