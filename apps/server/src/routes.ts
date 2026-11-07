import { randomUUID } from 'node:crypto';
import { compileQuery, projectStats, retentionStats, validateSql } from '@logbird/clickhouse';
import {
  API_KEY_SCOPES,
  apiKeySchema,
  createApiKeyResponseSchema,
  createApiKeySchema,
  createProjectResponseSchema,
  createProjectSchema,
  createSavedViewSchema,
  deleteProjectQuerySchema,
  meResponseSchema,
  projectSchema,
  retentionStatusQuerySchema,
  retentionStatusSchema,
  savedViewSchema,
  updateProjectSchema,
} from '@logbird/contracts';
import { prisma, withProjectLock } from '@logbird/database';
import { retentionQueue } from '@logbird/worker/queue';
import { enforceProjectRetention } from '@logbird/worker/retention';
import { Hono } from 'hono';
import { validator } from 'hono-openapi';
import { z } from 'zod';
import { clickhouse, purgeProjectEvents, queryClickhouse } from './clickhouse';
import { ApiError } from './errors';
import { audit } from './ingest';
import { generateApiKey } from './keys';
import { requireProjectAccess, requireSession } from './middlewares';
import { hasAdminRole } from './middlewares/require-role';
import { doc, routeDoc } from './openapi';
import { creatorSelect, serializeKey, serializeProject, serializeView } from './serialize';
import { invalidateSetup } from './setup-cache';
import type { AppEnv } from './types';

async function activeOrganization(c: import('hono').Context<AppEnv>) {
  const id = c.get('activeOrganizationId');
  if (!id || !(await prisma.member.findFirst({ where: { organizationId: id, userId: c.get('user').id } })))
    throw new ApiError(403, 'organization_required', 'Select an organization you belong to.');
  return id;
}
function auditApiKey(
  c: import('hono').Context<AppEnv>,
  action: 'api_key.created' | 'api_key.revoked',
  key: { id: string; name: string; kind: string; prefix: string },
  project: { id: string; name: string; organizationId: string },
  reason?: 'project_deleted',
) {
  return audit(c, action, { type: 'api_key', id: key.id, name: key.name }, undefined, {
    organizationId: project.organizationId,
    targets: [
      { type: 'api_key', id: key.id, name: key.name },
      { type: 'project', id: project.id, name: project.name },
    ],
    metadata: {
      apiKey: {
        kind: key.kind,
        scope: API_KEY_SCOPES[key.kind as keyof typeof API_KEY_SCOPES],
        prefix: key.prefix,
        state: action === 'api_key.created' ? 'active' : 'revoked',
        ...(reason ? { reason } : {}),
      },
    },
  });
}

export const managementRoutes = new Hono<AppEnv>()
  .use('*', requireSession)
  .get('/me', doc('Current user and workspaces', meResponseSchema), async (c) => {
    const memberships = await prisma.member.findMany({ where: { userId: c.get('user').id }, include: { organization: true } });
    return c.json(
      meResponseSchema.parse({
        user: c.get('user'),
        organizations: memberships.map((m) => ({ ...m.organization, role: m.role })),
        activeOrganizationId: c.get('activeOrganizationId'),
      }),
    );
  })
  .get('/projects', doc('List projects', z.object({ data: z.array(projectSchema) })), async (c) => {
    const projects = await prisma.project.findMany({ where: { organizationId: await activeOrganization(c) }, orderBy: { createdAt: 'asc' } });
    const stats = await projectStats(
      clickhouse,
      projects.map((p) => p.id),
    );
    return c.json({ data: projects.map((p) => ({ ...serializeProject(p), ...stats[p.id] })) });
  })
  .post(
    '/projects',
    doc('Create project and initial ingest key', createProjectResponseSchema, 201),
    validator('json', createProjectSchema, (result) => {
      if (!result.success) throw new ApiError(422, 'validation_error', 'Invalid request body.', result.error);
    }),
    async (c) => {
      const organizationId = await activeOrganization(c);
      const input = c.req.valid('json');
      const material = generateApiKey('ingest');
      const base =
        input.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'project';
      const result = await prisma.$transaction(async (tx) => {
        const project = await tx.project.create({ data: { ...input, organizationId, slug: `${base}-${randomUUID().slice(0, 8)}` } });
        const key = await tx.apiKey.create({
          data: {
            projectId: project.id,
            name: 'Initial ingest key',
            kind: 'ingest',
            hash: material.hash,
            prefix: material.prefix,
            createdById: c.get('user').id,
          },
          include: creatorSelect,
        });
        return { project: serializeProject(project), ingestKey: { key: serializeKey(key), secret: material.secret } };
      });
      await audit(c, 'project.created', { type: 'project', id: result.project.id, name: result.project.name });
      await auditApiKey(c, 'api_key.created', result.ingestKey.key, { ...result.project, organizationId });
      return c.json(createProjectResponseSchema.parse(result), 201);
    },
  )
  .use('/projects/:projectId', requireProjectAccess)
  .use('/projects/:projectId/*', requireProjectAccess)
  .get('/projects/:projectId', doc('Get project', projectSchema), async (c) =>
    c.json({ ...serializeProject(c.get('project')), ...(await projectStats(clickhouse, [c.get('project').id]))[c.get('project').id] }),
  )
  .get(
    '/projects/:projectId/retention',
    doc('Retention status and preview', retentionStatusSchema),
    validator('query', retentionStatusQuerySchema, (r) => {
      if (!r.success) throw new ApiError(422, 'validation_error', 'Invalid retention preview.');
    }),
    async (c) => {
      const project = c.get('project');
      const [stats, lastRun, scheduler] = await Promise.all([
        retentionStats(clickhouse, project.id, c.req.valid('query').preview),
        prisma.retentionRun.findFirst({ where: { projectId: project.id }, orderBy: { startedAt: 'desc' } }),
        retentionQueue.getJobScheduler('retention-hourly'),
      ]);
      return c.json(
        retentionStatusSchema.parse({
          retentionDays: project.retentionDays,
          ...stats,
          nextPurgeAt: scheduler?.next ? new Date(scheduler.next).toISOString() : null,
          lastRun: lastRun
            ? {
                ...lastRun,
                startedAt: lastRun.startedAt.toISOString(),
                finishedAt: lastRun.finishedAt?.toISOString() ?? null,
                cutoff: lastRun.cutoff.toISOString(),
              }
            : null,
        }),
      );
    },
  )
  .patch(
    '/projects/:projectId',
    doc('Update project', projectSchema),
    validator('json', updateProjectSchema, (result) => {
      if (!result.success) throw new ApiError(422, 'validation_error', 'Invalid request body.', result.error);
    }),
    async (c) => {
      const { confirm, retentionReviewed, setupDismissed, ...input } = c.req.valid('json');
      // Serialize policy changes so concurrent requests cannot bypass slug confirmation.
      const { project, before } = await withProjectLock(c.get('project').id, async (tx) => {
        const id = c.get('project').id;
        const current = await tx.project.findUniqueOrThrow({ where: { id } });
        if (input.retentionDays !== undefined && input.retentionDays < current.retentionDays && confirm !== current.slug)
          throw new ApiError(422, 'confirmation_required', 'Type the project slug to lower retention.');
        return {
          project: await tx.project.update({
            where: { id },
            data: {
              ...input,
              ...(retentionReviewed || (input.retentionDays !== undefined && input.retentionDays !== current.retentionDays)
                ? { retentionReviewedAt: new Date() }
                : {}),
              ...(setupDismissed !== undefined ? { setupDismissedAt: setupDismissed ? new Date() : null } : {}),
            },
          }),
          before: current,
        };
      });
      invalidateSetup(project.id);
      if (input.retentionDays !== undefined && input.retentionDays < before.retentionDays) await enforceProjectRetention(project.id);
      if (retentionReviewed) await audit(c, 'project.retention.reviewed', { type: 'project', id: project.id, name: project.name });
      if (setupDismissed !== undefined)
        await audit(c, 'project.setup.dismissed', { type: 'project', id: project.id, name: project.name }, [
          { field: 'setupDismissed', after: setupDismissed },
        ]);
      const changes = (['name', 'description'] as const)
        .filter((field) => before[field] !== project[field])
        .map((field) => ({ field, before: before[field], after: project[field] }));
      if (changes.length) await audit(c, 'project.updated', { type: 'project', id: project.id, name: project.name }, changes);
      if (input.retentionDays !== undefined && input.retentionDays !== before.retentionDays)
        await audit(c, 'project.retention.changed', { type: 'project', id: project.id, name: project.name }, [
          { field: 'retentionDays', before: before.retentionDays, after: project.retentionDays },
        ]);
      return c.json(serializeProject(project));
    },
  )
  .delete(
    '/projects/:projectId',
    routeDoc('Delete project', { responses: { 204: { description: 'Deleted' } } }),
    validator('query', deleteProjectQuerySchema),
    async (c) => {
      const { confirm } = c.req.valid('query');
      if (confirm !== c.get('project').slug) throw new ApiError(422, 'confirmation_required', 'Type the project slug to delete the project.');
      const projectId = c.get('project').id;
      await withProjectLock(projectId, async (tx) => {
        const revoked = await tx.apiKey.updateManyAndReturn({ where: { projectId, revokedAt: null }, data: { revokedAt: new Date() } });
        for (const key of revoked) await auditApiKey(c, 'api_key.revoked', key, c.get('project'), 'project_deleted');
        await purgeProjectEvents(projectId);
        await tx.project.delete({ where: { id: projectId } });
      });
      await audit(c, 'project.deleted', { type: 'project', id: projectId, name: c.get('project').name });
      return c.body(null, 204);
    },
  )
  .get('/projects/:projectId/keys', doc('List API keys', z.object({ data: z.array(apiKeySchema) })), async (c) =>
    c.json({
      data: (await prisma.apiKey.findMany({ where: { projectId: c.get('project').id }, include: creatorSelect, orderBy: { createdAt: 'asc' } })).map(
        serializeKey,
      ),
    }),
  )
  .post(
    '/projects/:projectId/keys',
    doc('Create API key', createApiKeyResponseSchema, 201),
    validator('json', createApiKeySchema, (result) => {
      if (!result.success) throw new ApiError(422, 'validation_error', 'Invalid request body.', result.error);
    }),
    async (c) => {
      const input = c.req.valid('json');
      const material = generateApiKey(input.kind);
      const key = await prisma.apiKey.create({
        data: { ...input, projectId: c.get('project').id, createdById: c.get('user').id, hash: material.hash, prefix: material.prefix },
        include: creatorSelect,
      });
      invalidateSetup(c.get('project').id);
      await auditApiKey(c, 'api_key.created', key, c.get('project'));
      return c.json({ key: serializeKey(key), secret: material.secret }, 201);
    },
  )
  .delete('/projects/:projectId/keys/:keyId', routeDoc('Revoke API key', { responses: { 204: { description: 'Revoked' } } }), async (c) => {
    const key = await prisma.apiKey.findFirst({ where: { id: c.req.param('keyId'), projectId: c.get('project').id } });
    if (!key) throw new ApiError(404, 'not_found', 'API key not found.');
    const result = await prisma.apiKey.updateMany({
      where: { id: key.id, projectId: c.get('project').id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    invalidateSetup(c.get('project').id);
    if (result.count) await auditApiKey(c, 'api_key.revoked', key, c.get('project'));
    return c.body(null, 204);
  })
  .get('/projects/:projectId/views', doc('List saved views', z.object({ data: z.array(savedViewSchema) })), async (c) =>
    c.json({
      data: (
        await prisma.savedView.findMany({ where: { projectId: c.get('project').id }, include: creatorSelect, orderBy: { createdAt: 'asc' } })
      ).map(serializeView),
    }),
  )
  .post(
    '/projects/:projectId/views',
    doc('Create saved view', savedViewSchema, 201),
    validator('json', createSavedViewSchema, (result) => {
      if (!result.success) throw new ApiError(422, 'validation_error', 'Invalid request body.', result.error);
    }),
    async (c) => {
      const { state } = c.req.valid('json');
      if (state.lang === 'sql') {
        if (!queryClickhouse) throw new ApiError(503, 'sql_mode_unavailable', 'Configure the restricted ClickHouse query user to enable SQL mode.');
        await validateSql(queryClickhouse, state.q);
      } else compileQuery(state.q);
      const view = await prisma.savedView.create({
        data: { ...c.req.valid('json'), projectId: c.get('project').id, createdById: c.get('user').id },
        include: creatorSelect,
      });
      await audit(c, 'saved_view.created', { type: 'saved_view', id: view.id, name: view.name });
      return c.json(serializeView(view), 201);
    },
  )
  .delete('/projects/:projectId/views/:viewId', routeDoc('Delete saved view', { responses: { 204: { description: 'Deleted' } } }), async (c) => {
    const view = await prisma.savedView.findFirst({ where: { id: c.req.param('viewId'), projectId: c.get('project').id } });
    const result = await prisma.savedView.deleteMany({
      where: {
        id: c.req.param('viewId'),
        projectId: c.get('project').id,
        ...(hasAdminRole(c.get('member').role) ? {} : { createdById: c.get('user').id }),
      },
    });
    if (!result.count) throw new ApiError(404, 'not_found', 'Saved view not found.');
    await audit(c, 'saved_view.deleted', { type: 'saved_view', id: c.req.param('viewId'), name: view?.name });
    return c.body(null, 204);
  });
