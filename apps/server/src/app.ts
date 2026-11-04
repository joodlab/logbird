import { apiReference } from '@scalar/hono-api-reference';
import { auth } from '@trailmark/auth';
import { Prisma, prisma } from '@trailmark/database';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { describeRoute, openAPIRouteHandler } from 'hono-openapi';
import { clickhouse } from './clickhouse';
import { env } from './env';
import { ApiError } from './errors';
import { managementRoutes } from './routes';
import type { AppEnv } from './types';

export const app = new Hono<AppEnv>();
app.use('*', requestId());
app.use('*', cors({ origin: env.APP_URL, credentials: true, exposeHeaders: ['X-Request-Id'] }));
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'http.request',
      requestId: c.get('requestId'),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - start,
    }),
  );
});
app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
    return c.json({ error: { code: 'conflict', message: 'This record already exists.' } }, 409);
  if (error instanceof HTTPException) return c.json({ error: { code: 'invalid_request', message: error.message } }, error.status);
  console.error(JSON.stringify({ level: 'error', event: 'http.error', requestId: c.get('requestId'), name: error.name }));
  return c.json({ error: { code: 'internal_error', message: 'An unexpected error occurred.' } }, 500);
});
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found.' } }, 404));
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
app.get('/health', describeRoute({ summary: 'Postgres and ClickHouse readiness' }), async (c) => {
  const checks = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    clickhouse.query({ query: 'SELECT 1', format: 'JSONEachRow' }).then((r) => r.json()),
  ]);
  const postgres = checks[0].status === 'fulfilled';
  const ch = checks[1].status === 'fulfilled';
  return c.json({ status: postgres && ch ? 'ok' : 'degraded', postgres, clickhouse: ch }, postgres && ch ? 200 : 503);
});
export const routes = app.route('/api', managementRoutes);
app.get(
  '/openapi.json',
  openAPIRouteHandler(app, {
    documentation: {
      info: { title: 'Trailmark API', version: '0.1.0' },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' } } },
    },
  }),
);
app.get('/docs', apiReference({ url: '/openapi.json' }));
