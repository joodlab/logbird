import { defineEventHandler, proxyRequest } from 'nitro/h3';
import { proxyDecision, referenceMethods, referenceStrippedHeaders } from './proxy-paths';

export default defineEventHandler((event) => {
  const url = new URL(event.req.url);
  const decision = proxyDecision(url.pathname, event.req.method);
  if (decision === 'console') return;
  // The public API reference is read-only: other methods never reach the API listener.
  if (decision === 'method-not-allowed') return new Response(null, { status: 405, headers: { Allow: referenceMethods.join(', ') } });
  // Nitro serves these routes before Vite's dev proxy, so `pnpm dev` needs the local server as its default; built
  // images default to the Compose service name. LOGBIRD_SERVER_URL overrides both.
  const fallback = import.meta.dev ? 'http://127.0.0.1:4601' : 'http://server:4601';
  const target = new URL(process.env.LOGBIRD_SERVER_URL || fallback);
  target.pathname = url.pathname;
  target.search = url.search;
  // The console is a trusted hop in front of the API: append the address it saw (browser or upstream proxy), as
  // a reverse proxy would. Only X-Forwarded-For: X-Forwarded-Proto/Host from an outer proxy must survive.
  const forwardedFor = event.req.headers.get('x-forwarded-for');
  const peer = event.req.ip;
  const headers = peer ? { 'x-forwarded-for': forwardedFor ? `${forwardedFor}, ${peer}` : peer } : undefined;
  return proxyRequest(event, target.href, {
    headers,
    // The reference is public: never pass the console session or an API key along with it.
    ...(decision === 'reference' ? { filterHeaders: [...referenceStrippedHeaders] } : {}),
  });
});
