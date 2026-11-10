import { defineEventHandler } from 'nitro/h3';

/**
 * Every /site-api/* path without its own route (only /site-api/waitlist has one) answers a JSON 404, so no API URL falls through to
 * TanStack Start's on-demand page renderer, whose inline scripts no build-time CSP hash covers. Registered after the
 * real routes in vite.config.ts; the more specific route wins.
 */
export default defineEventHandler(
  () =>
    new Response(JSON.stringify({ error: { code: 'not_found', message: 'No such API endpoint.' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    }),
);
