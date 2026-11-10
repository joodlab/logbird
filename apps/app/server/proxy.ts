import { defineEventHandler, proxyRequest } from 'nitro/h3';
import { proxyDecision, referenceMethods, referenceStrippedHeaders } from './proxy-paths';
import { siteApiMethods, siteDecision, siteMethods } from './site-paths';

export default defineEventHandler(async (event) => {
  const url = new URL(event.req.url);
  const decision = proxyDecision(url.pathname, event.req.method);
  if (decision === 'console') {
    const site = process.env.LOGBIRD_SITE_URL;
    if (!site) return;
    // URL/FastURL normalize dot segments. Retain the incoming path for the site's ambiguity guard.
    const pathname = event.req.url.match(/^[^:]+:\/\/[^/?#]+([^?#]*)/)?.[1] || '/';
    const request = { pathname, method: event.req.method, cookie: event.req.headers.get('cookie') };
    if (siteDecision(request) !== 'site') {
      if (siteDecision({ ...request, method: 'GET' }) === 'site') {
        const methods = url.pathname.startsWith('/site-api/') ? siteApiMethods : siteMethods;
        return new Response(null, { status: 405, headers: { Allow: methods.join(', ') } });
      }
      return;
    }
    try {
      const target = new URL(site);
      target.pathname = url.pathname;
      target.search = url.search;
      const forwardedFor = event.req.headers.get('x-forwarded-for');
      const peer = event.req.ip;
      const response = await proxyRequest(event, target.href, {
        headers: peer ? { 'x-forwarded-for': forwardedFor ? `${forwardedFor}, ${peer}` : peer } : undefined,
        filterHeaders: [...referenceStrippedHeaders],
        locationRewrite: false,
        timeout: 5000,
      });
      if ((response.status ?? 200) >= 500) {
        if (response.body instanceof ReadableStream) await response.body.cancel();
        if (url.pathname === '/') return;
        return new Response('Bad Gateway', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      response.headers.delete('set-cookie');
      // Nitro stages routeRules headers on event.res. H3 merges those OVER the returned proxy response, so remove
      // them only after a successful site response. The upstream owns all response policies, including its hashed CSP.
      for (const name of [...event.res.headers.keys()]) event.res.headers.delete(name);
      return response;
    } catch {
      if (url.pathname === '/') return;
      return new Response('Bad Gateway', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  }
  // The public API reference is read-only: other methods never reach the API listener.
  if (decision === 'method-not-allowed') return new Response(null, { status: 405, headers: { Allow: referenceMethods.join(', ') } });
  // Nitro is the only forwarding path, in `pnpm dev` too (there is no Vite proxy), so dev defaults to the local server;
  // built images default to the Compose service name. LOGBIRD_SERVER_URL overrides both.
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
