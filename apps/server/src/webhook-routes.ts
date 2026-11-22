import { randomUUID } from 'node:crypto';
import { compileMaskedQuery } from '@logbird/clickhouse';
import {
  apiErrorSchema,
  createWebhookResponseSchema,
  createWebhookSchema,
  listWebhookDeliveriesQuerySchema,
  listWebhookDeliveriesResponseSchema,
  listWebhooksResponseSchema,
  MAX_WEBHOOK_ENDPOINTS,
  queuedWebhookDeliverySchema,
  rotateWebhookSecretResponseSchema,
  rotateWebhookSecretSchema,
  storedWebhookScope,
  updateWebhookSchema,
  type WebhookScope,
  webhookEndpointSchema,
  webhookLookupBusySchema,
  webhookScopeFromColumns,
  webhookSecretOverlapLimitSchema,
} from '@logbird/contracts';
import { Prisma, prisma, type WebhookAttempt, type WebhookEndpoint } from '@logbird/database';
import {
  activeWebhookSecrets,
  encryptWebhookSecret,
  validateWebhookUrl,
  WEBHOOK_LOG_RETENTION_MS,
  WebhookLookupBusyError,
  WebhookUrlError,
  webhookSecretKey,
} from '@logbird/database/webhooks';
import { generateWebhookSecret, MAX_WEBHOOK_SIGNATURES } from '@logbird/sdk';
import { type Context, Hono } from 'hono';
import { resolver, validator } from 'hono-openapi';
import type { ZodType } from 'zod';
import { env } from './env';
import { ApiError } from './errors';
import { audit } from './ingest';
import { requireProjectAccess, requireSession } from './middlewares';
import { requireRole } from './middlewares/require-role';
import { doc, routeDoc } from './openapi';
import type { AppEnv } from './types';

const base = '/projects/:projectId/webhooks';
const secretKey = webhookSecretKey(env.BETTER_AUTH_SECRET, env.WEBHOOK_SECRET_KEY);
const rotationSummary = 'Rotate webhook secret (shown once; default 24-hour overlap, maximum 7 days)';
const webhookUrlDoc = (summary: string, schema: ZodType, status = 200) =>
  routeDoc(summary, {
    responses: {
      [status]: { description: summary, content: { 'application/json': { schema: resolver(schema) } } },
      422: {
        description: 'Invalid endpoint configuration or filter. Filters cannot reference masked fields.',
        content: { 'application/json': { schema: resolver(apiErrorSchema) } },
      },
      503: {
        description: 'Destination lookup capacity is busy. Retry after the indicated delay.',
        headers: { 'Retry-After': { description: 'Seconds before retrying', schema: { type: 'integer', example: 3 } } },
        content: { 'application/json': { schema: resolver(webhookLookupBusySchema) } },
      },
    },
  });
const updateWebhookDoc = webhookUrlDoc('Update webhook endpoint', webhookEndpointSchema);
function serialize(endpoint: WebhookEndpoint, activeSecretCount = 0) {
  const scope = storedWebhookScope(endpoint);
  const responseScope = scope === undefined ? (webhookEndpointSchema.shape.scope.safeParse(webhookScopeFromColumns(endpoint)).data ?? null) : scope;
  return webhookEndpointSchema.parse({
    ...endpoint,
    ...(activeSecretCount > MAX_WEBHOOK_SIGNATURES && { secretOverlapWarning: 'webhook_secret_overlap_limit' }),
    ...(scope === undefined && { scopeWarning: 'webhook_invalid_scope' }),
    ...(endpoint.cursorReviewRequired && { cursorWarning: 'webhook_cursor_review_required' }),
    scope: responseScope,
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
    disabledAt: endpoint.disabledAt?.toISOString() ?? null,
  });
}
const activeSecretCount = (now: Date) => ({ _count: { select: { secrets: { where: activeWebhookSecrets(now) } } } });
/** PostgreSQL time: the worker signs, expires secrets and schedules attempts on this clock, so the API uses it too. */
async function databaseNow(db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma) {
  const [{ now }] = await db.$queryRaw<[{ now: Date }]>`SELECT clock_timestamp() AS now`;
  return now;
}
const scopeColumns = (scope: WebhookScope | null) => ({
  scopeTenantId: scope?.tenantId ?? null,
  scopeTargetType: scope?.target?.type ?? null,
  scopeTargetId: scope?.target?.id ?? null,
  scopeMask: scope?.mask ?? [],
});
async function allowedUrl(c: Context<AppEnv>, url: string) {
  try {
    return await validateWebhookUrl(url, env.WEBHOOKS_ALLOW_HTTP, undefined, c.get('project').organizationId);
  } catch (error) {
    if (error instanceof WebhookLookupBusyError) throw new ApiError(503, error.code, error.message, undefined, 3);
    if (error instanceof WebhookUrlError) throw new ApiError(400, error.code, error.message);
    throw error;
  }
}
function requireEnabled(endpoint: WebhookEndpoint) {
  if (!endpoint.enabled) throw new ApiError(409, 'webhook_disabled', 'Enable this webhook before queuing a delivery.');
  if (storedWebhookScope(endpoint) === undefined)
    throw new ApiError(409, 'webhook_invalid_scope', 'Correct the stored webhook scope before queuing a delivery.');
}
const invalidBody = (result: { success: boolean; error?: unknown }) => {
  if (!result.success) throw new ApiError(422, 'validation_error', 'Invalid request body.', result.error);
};
const webhookBody = (result: { success: boolean; error?: readonly { path?: readonly (PropertyKey | { key: PropertyKey })[] }[] }) => {
  if (!result.success && result.error?.some((issue) => issue.path?.[0] === 'url'))
    throw new ApiError(400, 'webhook_url_not_allowed', 'Webhook URL must be a string of 1–2048 characters.');
  invalidBody(result);
};
/** Serialize endpoint mutations and the project limit; keep DNS outside the transaction. NO KEY UPDATE still serializes these
 * transactions but doesn't block the FOR KEY SHARE that foreign-key inserts into the project's other child tables take. */
async function lockedProject<T>(c: Context<AppEnv>, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    const [project] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Project" WHERE id=${c.get('project').id} AND "organizationId"=${c.get('activeOrganizationId')} FOR NO KEY UPDATE`;
    if (!project) throw new ApiError(404, 'not_found', 'Project not found.');
    const endpointId = c.req.param('id');
    if (endpointId) {
      // Dispatch holds a shared lock on this row until it starts the request. Automatic disable also takes this exclusive lock.
      await tx.$queryRaw`SELECT id FROM "WebhookEndpoint" WHERE id = ${endpointId} AND "projectId" = ${project.id} FOR UPDATE`;
    }
    return work(tx);
  });
}
async function findEndpoint(c: Context<AppEnv>, tx: Prisma.TransactionClient = prisma) {
  const endpoint = await tx.webhookEndpoint.findFirst({ where: { id: c.req.param('id'), projectId: c.get('project').id } });
  if (!endpoint) throw new ApiError(404, 'not_found', 'Webhook endpoint not found.');
  return endpoint;
}
function record(c: Context<AppEnv>, tx: Prisma.TransactionClient, action: string, endpoint: WebhookEndpoint, fields?: string[], reason?: string) {
  const url = new URL(endpoint.url);
  const project = c.get('project');
  return audit(
    c,
    action,
    { type: 'webhook', id: endpoint.id },
    fields?.map((field) => ({ field })),
    {
      organizationId: project.organizationId,
      targets: [
        { type: 'webhook', id: endpoint.id },
        { type: 'project', id: project.id, name: project.name },
      ],
      // Origin only: receivers such as Slack or Zapier carry their credential in the path or query.
      metadata: { webhook: { url: url.origin, ...(reason ? { reason } : {}) } },
    },
    tx,
  );
}

export const webhookRoutes = new Hono<AppEnv>()
  .use('*', requireSession)
  .use('/projects/:projectId/webhooks', requireProjectAccess)
  .use('/projects/:projectId/webhooks/*', requireProjectAccess)
  // Reads are owner/admin only too: a stored URL can itself be a credential (a Slack or Zapier hook path).
  .get(base, doc('List webhook endpoints (no secrets)', listWebhooksResponseSchema), async (c) => {
    await requireRole(c);
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { projectId: c.get('project').id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: activeSecretCount(await databaseNow()),
    });
    return c.json({ data: endpoints.map((endpoint) => serialize(endpoint, endpoint._count.secrets)) });
  })
  .post(
    base,
    webhookUrlDoc('Create webhook endpoint (secret shown once)', createWebhookResponseSchema, 201),
    validator('json', createWebhookSchema, webhookBody),
    async (c) => {
      const input = c.req.valid('json');
      compileMaskedQuery(input.filterQuery ?? '', input.scope?.mask);
      const url = await allowedUrl(c, input.url);
      const secret = generateWebhookSecret();
      const endpoint = await lockedProject(c, async (tx) => {
        if ((await tx.webhookEndpoint.count({ where: { projectId: c.get('project').id } })) >= MAX_WEBHOOK_ENDPOINTS)
          throw new ApiError(400, 'webhook_limit_reached', `A project may have at most ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints.`);
        const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        if (!clock) throw new Error('Webhook creation clock unavailable');
        const createdAt = clock.now;
        const endpoint = await tx.webhookEndpoint.create({
          data: {
            projectId: c.get('project').id,
            createdAt,
            cursorReceivedAt: createdAt,
            url,
            description: input.description,
            enabled: input.enabled ?? true,
            disabledReason: input.enabled === false ? 'manual' : null,
            disabledAt: input.enabled === false ? createdAt : null,
            filterQuery: input.filterQuery ?? '',
            ...scopeColumns(input.scope ?? null),
            createdById: c.get('user').id,
            secrets: { create: { ciphertext: encryptWebhookSecret(secret, secretKey) } },
          },
        });
        await record(c, tx, 'webhook.created', endpoint);
        return endpoint;
      });
      c.header('Cache-Control', 'no-store');
      return c.json({ endpoint: serialize(endpoint), secret }, 201);
    },
  )
  .get(`${base}/:id`, doc('Get webhook endpoint (no secrets)', webhookEndpointSchema), async (c) => {
    await requireRole(c);
    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: { id: c.req.param('id'), projectId: c.get('project').id },
      include: activeSecretCount(await databaseNow()),
    });
    if (!endpoint) throw new ApiError(404, 'not_found', 'Webhook endpoint not found.');
    return c.json(serialize(endpoint, endpoint._count.secrets));
  })
  .patch(`${base}/:id`, updateWebhookDoc, validator('json', updateWebhookSchema, webhookBody), async (c) => {
    const input = c.req.valid('json');
    // A missing endpoint is a 404 before any DNS lookup; the locked re-read below still decides.
    if (input.url !== undefined) await findEndpoint(c);
    const url = input.url === undefined ? undefined : await allowedUrl(c, input.url);
    const endpoint = await lockedProject(c, async (tx) => {
      const before = await findEndpoint(c, tx);
      if (input.scope !== undefined || input.filterQuery !== undefined) {
        const scope = input.scope === undefined ? storedWebhookScope(before) : input.scope;
        compileMaskedQuery(input.filterQuery ?? before.filterQuery, scope?.mask);
      }
      const enabledChanged = input.enabled !== undefined && input.enabled !== before.enabled;
      const scopeCorrected = input.scope !== undefined && (before.scopeReviewRequired || storedWebhookScope(before) === undefined);
      const now = await databaseNow(tx);
      const after = await tx.webhookEndpoint.update({
        where: { id: before.id },
        include: activeSecretCount(now),
        data: {
          url,
          description: input.description,
          filterQuery: input.filterQuery,
          enabled: input.enabled,
          ...(input.scope !== undefined ? scopeColumns(input.scope) : {}),
          ...(scopeCorrected && { scopeReviewRequired: false }),
          ...(enabledChanged ? { disabledReason: input.enabled ? null : 'manual', disabledAt: input.enabled ? null : now } : {}),
          ...((input.enabled && enabledChanged) || (url !== undefined && url !== before.url) ? { consecutiveFailures: 0, failingSince: null } : {}),
        },
      });
      if (scopeCorrected) {
        // Preserve attempt history and give previously attempted pending rows a full window after the hold.
        await tx.webhookDelivery.updateMany({
          where: { endpointId: before.id, status: 'pending', OR: [{ retryUntil: { not: null } }, { leaseUntil: { not: null } }] },
          data: { nextAttemptAt: now, retryUntil: null, windowAttempts: 0, leaseUntil: null },
        });
        await tx.webhookAttempt.updateMany({
          where: { status: 'sending', delivery: { endpointId: before.id, status: 'pending' } },
          data: { status: 'interrupted' },
        });
      }
      const old = serialize(before),
        current = serialize(after);
      const fields = (['url', 'description', 'filterQuery', 'scope', 'enabled'] as const).filter(
        (field) => (field === 'scope' && scopeCorrected) || JSON.stringify(old[field]) !== JSON.stringify(current[field]),
      );
      if (fields.length) await record(c, tx, 'webhook.updated', after, fields);
      if (enabledChanged) await record(c, tx, input.enabled ? 'webhook.enabled' : 'webhook.disabled', after, ['enabled'], 'manual');
      return after;
    });
    return c.json(serialize(endpoint, endpoint._count.secrets));
  })
  .delete(`${base}/:id`, routeDoc('Delete webhook endpoint', { responses: { 204: { description: 'Deleted' } } }), async (c) => {
    await lockedProject(c, async (tx) => {
      const endpoint = await findEndpoint(c, tx);
      await tx.webhookEndpoint.delete({ where: { id: endpoint.id } });
      await record(c, tx, 'webhook.deleted', endpoint);
    });
    return c.body(null, 204);
  })
  .post(`${base}/:id/test`, doc('Queue a webhook test event', queuedWebhookDeliverySchema, 202), async (c) => {
    const row = await lockedProject(c, async (tx) => {
      const endpoint = await findEndpoint(c, tx);
      requireEnabled(endpoint);
      const delivery = await tx.webhookDelivery.create({
        data: { endpointId: endpoint.id, eventId: randomUUID(), expiresAt: new Date(+(await databaseNow(tx)) + WEBHOOK_LOG_RETENTION_MS) },
      });
      await record(c, tx, 'webhook.test_queued', endpoint);
      return delivery;
    });
    return c.json(queuedWebhookDeliverySchema.parse({ ...row, kind: 'test' }), 202);
  })
  .get(
    `${base}/:id/deliveries`,
    doc('List webhook deliveries and attempts', listWebhookDeliveriesResponseSchema),
    validator('query', listWebhookDeliveriesQuerySchema, invalidBody),
    async (c) => {
      await requireRole(c);
      const endpoint = await findEndpoint(c);
      const { status, cursor } = c.req.valid('query');
      const now = await databaseNow();
      const rows = await prisma.webhookDelivery.findMany({
        where: { endpointId: endpoint.id, status, id: cursor ? { lt: cursor } : undefined, OR: [{ status: 'pending' }, { expiresAt: { gt: now } }] },
        orderBy: { id: 'desc' },
        take: 21,
      });
      const page = rows.slice(0, 20);
      const attempts = page.length
        ? await prisma.$queryRaw<WebhookAttempt[]>(Prisma.sql`
            SELECT a.* FROM (VALUES ${Prisma.join(page.map(({ id, attemptNumber }) => Prisma.sql`(${id}::text, ${attemptNumber}::int)`))}) d(id, last)
            CROSS JOIN LATERAL (
              SELECT * FROM "WebhookAttempt" WHERE "deliveryId" = d.id AND number <= d.last
                AND "startedAt" > ${new Date(+now - WEBHOOK_LOG_RETENTION_MS)}
              ORDER BY number DESC LIMIT 5
            ) a ORDER BY a."deliveryId", a.number`)
        : [];
      c.header('Cache-Control', 'no-store');
      return c.json(
        listWebhookDeliveriesResponseSchema.parse({
          data: page.map((row) => ({
            ...row,
            kind: row.receivedAt ? 'event' : 'test',
            createdAt: row.createdAt.toISOString(),
            nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
            attemptCount: row.attemptNumber,
            attempts: attempts
              .filter(({ deliveryId }) => deliveryId === row.id)
              .map((attempt) => ({ ...attempt, startedAt: attempt.startedAt.toISOString() })),
          })),
          nextCursor: rows.length > 20 ? (page.at(-1)?.id ?? null) : null,
        }),
      );
    },
  )
  .post(`${base}/:id/deliveries/:deliveryId/resend`, doc('Requeue a webhook delivery', queuedWebhookDeliverySchema, 202), async (c) => {
    const row = await lockedProject(c, async (tx) => {
      const endpoint = await findEndpoint(c, tx);
      requireEnabled(endpoint);
      const now = await databaseNow(tx);
      const delivery = await tx.webhookDelivery.findFirst({
        where: { id: c.req.param('deliveryId'), endpointId: endpoint.id, OR: [{ status: 'pending' }, { expiresAt: { gt: now } }] },
      });
      if (!delivery) throw new ApiError(404, 'not_found', 'Webhook delivery not found.');
      const updated = await tx.webhookDelivery.updateMany({
        where: { id: delivery.id, status: { not: 'pending' } },
        data: { status: 'pending', nextAttemptAt: now, retryUntil: null, windowAttempts: 0 },
      });
      if (!updated.count) throw new ApiError(409, 'webhook_delivery_pending', 'This delivery is already pending.');
      await record(c, tx, 'webhook.resend_queued', endpoint);
      return delivery;
    });
    return c.json(queuedWebhookDeliverySchema.parse({ ...row, status: 'pending', kind: row.receivedAt ? 'event' : 'test' }), 202);
  })
  .post(
    `${base}/:id/rotate-secret`,
    routeDoc(rotationSummary, {
      responses: {
        200: { description: rotationSummary, content: { 'application/json': { schema: resolver(rotateWebhookSecretResponseSchema) } } },
        409: {
          description: `Rotation would exceed the limit of ${MAX_WEBHOOK_SIGNATURES} active secrets. Wait for an expiry or rotate with zero overlap.`,
          content: { 'application/json': { schema: resolver(webhookSecretOverlapLimitSchema) } },
        },
      },
    }),
    validator('json', rotateWebhookSecretSchema, invalidBody),
    async (c) => {
      const { overlapSeconds } = c.req.valid('json');
      const secret = generateWebhookSecret();
      await lockedProject(c, async (tx) => {
        const endpoint = await findEndpoint(c, tx);
        // Every earlier secret stops working by the end of this overlap: the current one and any still inside an earlier
        // rotation's window. An expiry already sooner is left alone, so a rotation never extends a secret's life, and a
        // zero overlap retires every earlier secret at once.
        const now = await databaseNow(tx);
        const until = new Date(now.getTime() + overlapSeconds * 1000);
        // Secrets past their window can never sign again: drop them so rotations don't accumulate rows.
        await tx.webhookSecret.deleteMany({ where: { endpointId: endpoint.id, expiresAt: { lte: now } } });
        if (overlapSeconds > 0 && (await tx.webhookSecret.count({ where: { endpointId: endpoint.id } })) >= MAX_WEBHOOK_SIGNATURES)
          throw new ApiError(
            409,
            'webhook_secret_overlap_limit',
            `At most ${MAX_WEBHOOK_SIGNATURES} active secrets are supported. Wait for an expiry or rotate with zero overlap.`,
          );
        await tx.webhookSecret.updateMany({
          where: { endpointId: endpoint.id, OR: [{ expiresAt: null }, { expiresAt: { gt: until } }] },
          data: { expiresAt: until },
        });
        await tx.webhookSecret.create({ data: { endpointId: endpoint.id, ciphertext: encryptWebhookSecret(secret, secretKey) } });
        await tx.webhookEndpoint.update({ where: { id: endpoint.id }, data: { updatedAt: now } });
        await record(c, tx, 'webhook.secret_rotated', endpoint);
      });
      c.header('Cache-Control', 'no-store');
      return c.json({ secret });
    },
  );
