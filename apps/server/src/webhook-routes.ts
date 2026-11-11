import { compileQuery } from '@logbird/clickhouse';
import {
  createWebhookResponseSchema,
  createWebhookSchema,
  listWebhooksResponseSchema,
  MAX_WEBHOOK_ENDPOINTS,
  rotateWebhookSecretResponseSchema,
  rotateWebhookSecretSchema,
  updateWebhookSchema,
  webhookEndpointSchema,
} from '@logbird/contracts';
import { type Prisma, prisma, type WebhookEndpoint } from '@logbird/database';
import { encryptWebhookSecret, validateWebhookUrl, WebhookUrlError, webhookSecretKey } from '@logbird/database/webhooks';
import { generateWebhookSecret } from '@logbird/sdk';
import { type Context, Hono } from 'hono';
import { validator } from 'hono-openapi';
import { env } from './env';
import { ApiError } from './errors';
import { audit } from './ingest';
import { requireProjectAccess, requireSession } from './middlewares';
import { doc, routeDoc } from './openapi';
import type { AppEnv } from './types';

const base = '/projects/:projectId/webhooks';
const secretKey = webhookSecretKey(env.BETTER_AUTH_SECRET, env.WEBHOOK_SECRET_KEY);
function serialize(endpoint: WebhookEndpoint) {
  return webhookEndpointSchema.parse({
    ...endpoint,
    scope:
      endpoint.scopeTenantId || endpoint.scopeTargetType
        ? {
            ...(endpoint.scopeTenantId ? { tenantId: endpoint.scopeTenantId } : {}),
            ...(endpoint.scopeTargetType ? { target: { type: endpoint.scopeTargetType, id: endpoint.scopeTargetId } } : {}),
          }
        : null,
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
    disabledAt: endpoint.disabledAt?.toISOString() ?? null,
  });
}
const scopeColumns = (scope: { tenantId?: string; target?: { type: string; id: string } } | null) => ({
  scopeTenantId: scope?.tenantId ?? null,
  scopeTargetType: scope?.target?.type ?? null,
  scopeTargetId: scope?.target?.id ?? null,
});
async function allowedUrl(url: string) {
  try {
    return await validateWebhookUrl(url, env.WEBHOOKS_ALLOW_HTTP);
  } catch (error) {
    if (error instanceof WebhookUrlError) throw new ApiError(400, error.code, error.message);
    throw error;
  }
}
const invalidBody = (result: { success: boolean; error?: unknown }) => {
  if (!result.success) throw new ApiError(422, 'validation_error', 'Invalid request body.', result.error);
};
const webhookBody = (result: { success: boolean; error?: readonly { path?: readonly (PropertyKey | { key: PropertyKey })[] }[] }) => {
  if (!result.success && result.error?.some((issue) => issue.path?.[0] === 'url'))
    throw new ApiError(400, 'webhook_url_not_allowed', 'Webhook URL must be a string of 1–2048 characters.');
  invalidBody(result);
};
/** Serialize endpoint mutations and the project limit; keep DNS outside the transaction. */
async function lockedProject<T>(c: Context<AppEnv>, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Project" WHERE id=${c.get('project').id} AND "organizationId"=${c.get('activeOrganizationId')} FOR UPDATE`;
    if (!rows.length) throw new ApiError(404, 'not_found', 'Project not found.');
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
      metadata: { webhook: { url: `${url.origin}${url.pathname}`, ...(reason ? { reason } : {}) } },
    },
    tx,
  );
}

export const webhookRoutes = new Hono<AppEnv>()
  .use('*', requireSession)
  .use('/projects/:projectId/webhooks', requireProjectAccess)
  .use('/projects/:projectId/webhooks/*', requireProjectAccess)
  .get(base, doc('List webhook endpoints (no secrets)', listWebhooksResponseSchema), async (c) => {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { projectId: c.get('project').id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return c.json({ data: endpoints.map(serialize) });
  })
  .post(
    base,
    doc('Create webhook endpoint (secret shown once)', createWebhookResponseSchema, 201),
    validator('json', createWebhookSchema, webhookBody),
    async (c) => {
      const input = c.req.valid('json');
      compileQuery(input.filterQuery ?? '');
      const url = await allowedUrl(input.url);
      const secret = generateWebhookSecret();
      const endpoint = await lockedProject(c, async (tx) => {
        if ((await tx.webhookEndpoint.count({ where: { projectId: c.get('project').id } })) >= MAX_WEBHOOK_ENDPOINTS)
          throw new ApiError(400, 'webhook_limit_reached', `A project may have at most ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints.`);
        const endpoint = await tx.webhookEndpoint.create({
          data: {
            projectId: c.get('project').id,
            url,
            description: input.description,
            enabled: input.enabled ?? true,
            disabledReason: input.enabled === false ? 'manual' : null,
            disabledAt: input.enabled === false ? new Date() : null,
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
  .get(`${base}/:id`, doc('Get webhook endpoint (no secrets)', webhookEndpointSchema), async (c) => c.json(serialize(await findEndpoint(c))))
  .patch(`${base}/:id`, doc('Update webhook endpoint', webhookEndpointSchema), validator('json', updateWebhookSchema, webhookBody), async (c) => {
    const input = c.req.valid('json');
    if (input.filterQuery !== undefined) compileQuery(input.filterQuery);
    const url = input.url === undefined ? undefined : await allowedUrl(input.url);
    const endpoint = await lockedProject(c, async (tx) => {
      const before = await findEndpoint(c, tx);
      const enabledChanged = input.enabled !== undefined && input.enabled !== before.enabled;
      const after = await tx.webhookEndpoint.update({
        where: { id: before.id },
        data: {
          url,
          description: input.description,
          filterQuery: input.filterQuery,
          enabled: input.enabled,
          ...(input.scope !== undefined ? scopeColumns(input.scope) : {}),
          ...(enabledChanged ? { disabledReason: input.enabled ? null : 'manual', disabledAt: input.enabled ? null : new Date() } : {}),
        },
      });
      const old = serialize(before),
        current = serialize(after);
      const fields = (['url', 'description', 'filterQuery', 'scope', 'enabled'] as const).filter(
        (field) => JSON.stringify(old[field]) !== JSON.stringify(current[field]),
      );
      if (fields.length) await record(c, tx, 'webhook.updated', after, fields);
      if (enabledChanged) await record(c, tx, input.enabled ? 'webhook.enabled' : 'webhook.disabled', after, ['enabled'], 'manual');
      return after;
    });
    return c.json(serialize(endpoint));
  })
  .delete(`${base}/:id`, routeDoc('Delete webhook endpoint', { responses: { 204: { description: 'Deleted' } } }), async (c) => {
    await lockedProject(c, async (tx) => {
      const endpoint = await findEndpoint(c, tx);
      await tx.webhookEndpoint.delete({ where: { id: endpoint.id } });
      await record(c, tx, 'webhook.deleted', endpoint);
    });
    return c.body(null, 204);
  })
  .post(
    `${base}/:id/rotate-secret`,
    doc('Rotate webhook secret (shown once; default 24-hour overlap, maximum 7 days)', rotateWebhookSecretResponseSchema),
    validator('json', rotateWebhookSecretSchema, invalidBody),
    async (c) => {
      const { overlapSeconds } = c.req.valid('json');
      const secret = generateWebhookSecret();
      await lockedProject(c, async (tx) => {
        const endpoint = await findEndpoint(c, tx);
        // Every earlier secret stops working by the end of this overlap: the current one and any still inside an earlier
        // rotation's window. An expiry already sooner is left alone, so a rotation never extends a secret's life, and a
        // zero overlap retires every earlier secret at once.
        const until = new Date(Date.now() + overlapSeconds * 1000);
        await tx.webhookSecret.updateMany({
          where: { endpointId: endpoint.id, OR: [{ expiresAt: null }, { expiresAt: { gt: until } }] },
          data: { expiresAt: until },
        });
        await tx.webhookSecret.create({ data: { endpointId: endpoint.id, ciphertext: encryptWebhookSecret(secret, secretKey) } });
        await record(c, tx, 'webhook.secret_rotated', endpoint);
      });
      c.header('Cache-Control', 'no-store');
      return c.json({ secret });
    },
  );
