import { defineEventHandler, proxyRequest } from 'nitro/h3';

export default defineEventHandler((event) => {
  const url = new URL(event.req.url);
  if (!/^\/(api|v1)(\/|$)/.test(url.pathname) && !['/health', '/livez', '/readyz'].includes(url.pathname)) return;
  const target = new URL(process.env.TRAILMARK_SERVER_URL || 'http://server:4601');
  target.pathname = url.pathname;
  target.search = url.search;
  return proxyRequest(event, target.href);
});
