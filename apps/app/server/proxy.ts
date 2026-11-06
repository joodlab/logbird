import { defineEventHandler, proxyRequest } from 'nitro/h3';

export default defineEventHandler((event) => {
  const url = new URL(event.req.url);
  if (!/^\/(api|v1)(\/|$)/.test(url.pathname) && !['/health', '/livez', '/readyz'].includes(url.pathname)) return;
  const target = new URL(process.env.LOGBIRD_SERVER_URL || 'http://server:4601');
  target.pathname = url.pathname;
  target.search = url.search;
  // The console is a trusted hop in front of the API: append the address it saw (browser or upstream proxy), as
  // a reverse proxy would. Only X-Forwarded-For: X-Forwarded-Proto/Host from an outer proxy must survive.
  const forwardedFor = event.req.headers.get('x-forwarded-for');
  const peer = event.req.ip;
  const headers = peer ? { 'x-forwarded-for': forwardedFor ? `${forwardedFor}, ${peer}` : peer } : undefined;
  return proxyRequest(event, target.href, { headers });
});
