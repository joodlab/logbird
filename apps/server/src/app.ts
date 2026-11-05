import { apiReference } from '@scalar/hono-api-reference';
import { auth, authAuditContext, setAuthAuditHandler } from '@trailmark/auth';
import { QueryError } from '@trailmark/clickhouse';
import { queryErrorDetailsSchema } from '@trailmark/contracts';
import { Prisma, prisma } from '@trailmark/database';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { openAPIRouteHandler } from 'hono-openapi';
import { z } from 'zod';
import { clickhouse } from './clickhouse';
import { dataRoutes, publicRoutes } from './data-routes';
import { env } from './env';
import { ApiError } from './errors';
import { ingest } from './ingest';
import { invitationRoutes } from './invitation-routes';
import { inviteLinkRoutes } from './invite-link-routes';
import { doc, routeDoc } from './openapi';
import { managementRoutes } from './routes';
import { setupRoutes } from './setup-routes';
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
      path: c.req.path.replace(/(\/api\/invite-links\/)[^/]+/, '$1[redacted]'),
      status: c.res.status,
      durationMs: Date.now() - start,
    }),
  );
});
app.onError((error, c) => {
  if (error instanceof QueryError)
    return c.json({ error: { code: 'invalid_query', message: error.message, details: queryErrorDetailsSchema.parse(error.details) } }, 422);
  if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
    return c.json({ error: { code: 'conflict', message: 'This record already exists.' } }, 409);
  if (error instanceof HTTPException) return c.json({ error: { code: 'invalid_request', message: error.message } }, error.status);
  if (/^(Invalid (time range|cursor|query syntax)|Query exceeds|Unterminated quoted query)/.test(error.message) && !('code' in error))
    return c.json({ error: { code: 'invalid_query', message: error.message } }, 422);
  if ('code' in error || /timeout|budget/i.test(error.message))
    return c.json(
      { error: { code: 'query_unavailable', message: 'Storage query failed or exceeded its budget. Narrow the time range and retry.' } },
      503,
    );
  console.error(JSON.stringify({ level: 'error', event: 'http.error', requestId: c.get('requestId'), name: error.name }));
  return c.json({ error: { code: 'internal_error', message: 'An unexpected error occurred.' } }, 500);
});
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found.' } }, 404));
setAuthAuditHandler((e) =>
  ingest(`ws:${e.organizationId}`, {
    action: e.action,
    actor: { ...e.actor, type: 'user' },
    executor: { type: 'api', id: 'api-server' },
    targets: [e.target],
    changes: e.changes,
    context: e.context,
    occurredAt: new Date().toISOString(),
    description: e.action,
  }),
);
app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return authAuditContext.run(
    { actor: session?.user, requestId: c.get('requestId'), ip: c.req.header('x-forwarded-for') ?? '', userAgent: c.req.header('user-agent') ?? '' },
    () => auth.handler(c.req.raw),
  );
});
app.get(
  '/health',
  doc(
    'Postgres and ClickHouse readiness',
    z.object({ status: z.enum(['ok', 'degraded']), postgres: z.boolean(), clickhouse: z.boolean() }),
    200,
    'none',
  ),
  async (c) => {
    const checks = await Promise.allSettled([
      prisma.$queryRaw`SELECT 1`,
      clickhouse.query({ query: 'SELECT 1', format: 'JSONEachRow' }).then((r) => r.json()),
    ]);
    const postgres = checks[0].status === 'fulfilled';
    const ch = checks[1].status === 'fulfilled';
    return c.json({ status: postgres && ch ? 'ok' : 'degraded', postgres, clickhouse: ch }, postgres && ch ? 200 : 503);
  },
);
export const routes = app
  .route('/api', inviteLinkRoutes)
  .route('/api', invitationRoutes)
  .route('/api', setupRoutes)
  .route('/api', dataRoutes)
  .route('/api', managementRoutes)
  .route('/v1', publicRoutes);
app.get(
  '/openapi.json',
  routeDoc('OpenAPI document', { hide: true }, 'none'),
  openAPIRouteHandler(app, {
    documentation: {
      info: { title: 'Trailmark API', version: '0.1.0' },
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' },
          ingestKey: { type: 'http', scheme: 'bearer' },
          readKey: { type: 'http', scheme: 'bearer' },
        },
      },
    },
  }),
);
app.get('/docs', apiReference({ url: '/openapi.json' }));
