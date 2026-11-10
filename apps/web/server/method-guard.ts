import { defineEventHandler } from 'nitro/h3';
import { securityHeaders } from '../src/lib/security-headers';

/**
 * Every build (Node and Cloudflare): a request with a method other than GET or HEAD outside /site-api/ gets 405. Pages are
 * static; without this, a POST to a page path would reach TanStack Start's on-demand renderer (on Cloudflare, the
 * asset router only answers GET/HEAD and hands other methods to the Worker), whose inline scripts no build-time CSP
 * hash covers. The waitlist form posts to /site-api/waitlist, which is untouched.
 */
export default defineEventHandler((event) => {
  const method = event.req.method;
  if (method === 'GET' || method === 'HEAD' || event.url.pathname.startsWith('/site-api/')) {
    return;
  }
  return new Response(null, { status: 405, headers: { ...securityHeaders, Allow: 'GET, HEAD' } });
});
