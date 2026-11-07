import { auth, authAuditContext, setAuthAuditHandler } from '@logbird/auth';
import { QueryError } from '@logbird/clickhouse';
import { queryErrorDetailsSchema } from '@logbird/contracts';
import { Prisma, ProjectBusyError, prisma } from '@logbird/database';
import { connection } from '@logbird/worker/queue';
import { apiReference } from '@scalar/hono-api-reference';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { openAPIRouteHandler } from 'hono-openapi';
import { z } from 'zod';
import { queueAuditEvent } from './audit-outbox';
import { recordFailedSignIn } from './auth-activity';
import { clickhouse } from './clickhouse';
import { dataRoutes, publicRoutes } from './data-routes';
import { env } from './env';
import { ApiError } from './errors';
import { invitationRoutes } from './invitation-routes';
import { inviteLinkRoutes } from './invite-link-routes';
import { authorizeMutation } from './middlewares/require-role';
import { doc, routeDoc } from './openapi';
import { auditDrainStatus } from './outbox-delivery';
import { clientAddress, rateLimit } from './rate-limit';
import { managementRoutes } from './routes';
import { sessionRoutes } from './session-routes';
import { setupRoutes } from './setup-routes';
import type { AppEnv } from './types';

export const app = new Hono<AppEnv>();
app.use('*', requestId());
app.use('*', secureHeaders({ strictTransportSecurity: env.APP_URL.startsWith('https:') ? 'max-age=31536000' : false }));
// Ingest has its own decoded streaming limit, including gzip.
app.use(
  '/api/*',
  bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: { code: 'payload_too_large', message: 'Request exceeds 5 MB.' } }, 413) }),
);
app.use('/api/auth/*', rateLimit);
app.use('/api/session/*', rateLimit);
app.use('/api/sessions/*', rateLimit);
app.use(
  '*',
  cors({
    origin: [env.APP_URL, ...env.TRUSTED_ORIGINS.split(',').filter(Boolean)],
    credentials: true,
    exposeHeaders: [
      'X-Logbird-Export-Id',
      'X-Logbird-Export-Schema',
      'X-Request-Id',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
    ],
  }),
);
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'http.request',
      requestId: c.get('requestId'),
      method: c.req.method,
      path: c.req.path.replace(/(\/api\/(?:invite-links|invitations)\/)[^/]+/g, '$1[redacted]'),
      status: c.res.status,
      durationMs: Date.now() - start,
    }),
  );
});
app.onError((error, c) => {
  if (error instanceof ProjectBusyError) {
    c.header('Retry-After', '1');
    return c.json({ error: { code: 'project_busy', message: error.message } }, 503);
  }

  if (error instanceof QueryError)
    return c.json({ error: { code: 'invalid_query', message: error.message, details: queryErrorDetailsSchema.parse(error.details) } }, 422);
  if (error instanceof ApiError) {
    if (error.code === 'retention_unavailable') c.header('Retry-After', '1');
    return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.status);
  }
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
  queueAuditEvent(`ws:${e.organizationId}`, {
    action: e.action,
    actor: { ...e.actor, type: 'user', name: e.actor.name || e.actor.email },
    executor: { type: 'api', id: 'api-server' },
    targets: [e.target],
    changes: e.changes as import('@logbird/database').Prisma.InputJsonValue[],
    context: e.context ? { requestId: e.context.requestId, ip: e.context.ip, userAgent: e.context.userAgent } : undefined,
    occurredAt: new Date().toISOString(),
    description: e.description ?? e.action,
  }),
);
app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
  const authPath = c.req.path.replace(/\/+$/, '');
  if (['sign-out', 'revoke-session', 'revoke-sessions', 'revoke-other-sessions'].some((path) => authPath === `/api/auth/${path}`))
    return c.json({ error: { code: 'use_owned_session_endpoint', message: 'Use the self-only /api/session or /api/sessions routes.' } }, 409);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const authBody = ['/api/auth/organization/invite-member', '/api/auth/sign-in/email-otp'].includes(c.req.path)
    ? await c.req.raw
        .clone()
        .json()
        .catch(() => null)
    : null;
  const pendingResend =
    authBody?.resend === true &&
    typeof authBody.email === 'string' &&
    (authBody.organizationId === undefined || typeof authBody.organizationId === 'string') &&
    session
      ? await prisma.invitation.findFirst({
          where: {
            organizationId: authBody.organizationId ?? session.session.activeOrganizationId ?? '',
            email: String(authBody.email).toLowerCase(),
            status: 'pending',
          },
        })
      : null;
  const runAuth = () =>
    authAuditContext.run(
      {
        actor: session?.user,
        requestId: c.get('requestId'),
        ip: clientAddress(c) ?? '',
        userAgent: c.req.header('user-agent') ?? '',
        path: c.req.path,
      },
      async () => {
        const response = await auth.handler(c.req.raw);
        if (!response.ok && c.req.path === '/api/auth/sign-in/email-otp') {
          await recordFailedSignIn(c, authBody?.email, response);
        }
        // Installed better-auth skips organization hooks on resend; audit the successful endpoint result.
        if (response.ok && c.req.path === '/api/auth/organization/invite-member' && session && pendingResend) {
          const invitation = await response.clone().json();
          if (invitation.id === pendingResend.id)
            await queueAuditEvent(`ws:${invitation.organizationId}`, {
              action: 'member.invitation.resent',
              actor: { ...session.user, type: 'user' },
              targets: [{ type: 'invitation', id: invitation.id, name: invitation.email }],
              executor: { type: 'api', id: 'api-server' },
            });
        }
        return response;
      },
    );
  return runAuth();
});
app.get('/livez', (c) => c.json({ status: 'ok' }));
app.get('/readyz', async (c) => {
  const checks = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    clickhouse.ping().then((r) => {
      if (!r.success) throw new Error('Storage unavailable');
    }),
    connection.ping(),
  ]);
  const ready = checks.every((r) => r.status === 'fulfilled');
  const audit = await auditDrainStatus().catch(() => ({ unavailable: true }));
  return c.json({ status: ready ? 'ok' : 'degraded', audit }, ready ? 200 : 503);
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
app.use('/api/*', authorizeMutation);
export const routes = app
  .route('/api', sessionRoutes)
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
      info: { title: 'Logbird API', version: '0.1.0' },
      servers: [{ url: env.APP_URL, description: 'This Logbird instance' }],
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
