import { projectSetupSchema, SETUP_STEPS, sampleDataResponseSchema, workspaceSetupSchema } from '@trailmark/contracts';
import { prisma, withProjectLock } from '@trailmark/database';
import { Hono } from 'hono';
import { clickhouse } from './clickhouse';
import { ApiError } from './errors';
import { audit, requireProjectReadable, requireRetentionReady } from './ingest';
import { requireProjectAccess, requireSession } from './middlewares';
import { doc, routeDoc } from './openapi';
import { loadSampleData, removeSampleData } from './sample-data';
import { invalidateSetup, setupFacts } from './setup-cache';
import { computeSetup } from './setup-status';
import type { AppEnv } from './types';

async function teamFacts(organizationId: string) {
  const [members, pendingInvitations] = await Promise.all([
    prisma.member.count({ where: { organizationId } }),
    prisma.invitation.count({ where: { organizationId, status: 'pending', expiresAt: { gt: new Date() } } }),
  ]);
  return { members, pendingInvitations };
}
async function projectSetup(projectId: string, team: Awaited<ReturnType<typeof teamFacts>>, tolerateBusy = false) {
  try {
    await requireProjectReadable(projectId);
  } catch (error) {
    if (!tolerateBusy || !(error instanceof ApiError) || error.code !== 'retention_unavailable') throw error;
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    return {
      projectId,
      retentionBusy: true,
      progress: { done: 0, total: SETUP_STEPS.length },
      complete: false,
      nextStep: null,
      dismissedAt: project.setupDismissedAt?.toISOString() ?? null,
      completedAt: project.setupCompletedAt?.toISOString() ?? null,
      ingest: { firstEventAt: null, lastEventAt: null },
    };
  }
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { keys: { where: { revokedAt: null } } } });
  const result = computeSetup(project, await setupFacts(projectId), team);
  if (result.complete && !project.setupCompletedAt) {
    await prisma.project.updateMany({ where: { id: projectId, setupCompletedAt: null }, data: { setupCompletedAt: new Date() } });
    const saved = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    result.completedAt = saved.setupCompletedAt?.toISOString() ?? null;
  }
  return result;
}
export const setupRoutes = new Hono<AppEnv>()
  .use('*', requireSession)
  .get('/workspace/setup', doc('Workspace setup', workspaceSetupSchema), async (c) => {
    const organizationId = c.get('activeOrganizationId');
    if (organizationId && !(await prisma.member.findFirst({ where: { organizationId, userId: c.get('user').id } })))
      throw new ApiError(403, 'organization_required', 'Select a workspace you belong to.');
    const team = organizationId ? await teamFacts(organizationId) : { members: 0, pendingInvitations: 0 };
    const projects = organizationId
      ? await prisma.project.findMany({ where: { organizationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
      : [];
    const statuses = await Promise.all(projects.map((p) => projectSetup(p.id, team, true)));
    const active = [...statuses].sort((a, b) => (b.ingest.lastEventAt ?? '').localeCompare(a.ingest.lastEventAt ?? ''))[0];
    const next = !c.get('user').name?.trim()
      ? 'profile'
      : !organizationId
        ? 'workspace'
        : !projects.length
          ? 'project'
          : !statuses.some((s) => s.ingest.firstEventAt)
            ? 'first_event'
            : null;
    return c.json(
      workspaceSetupSchema.parse({
        organizationId,
        team,
        onboarding: { next, projectId: next === null ? (active?.projectId ?? null) : (projects[0]?.id ?? null) },
        projects: statuses.map((s, i) => ({ ...s, name: projects[i]?.name, slug: projects[i]?.slug, firstEventAt: s.ingest.firstEventAt })),
      }),
    );
  })
  .use('/projects/:projectId/*', requireProjectAccess)
  .get('/projects/:projectId/setup', doc('Project setup', projectSetupSchema), async (c) =>
    c.json(projectSetupSchema.parse(await projectSetup(c.get('project').id, await teamFacts(c.get('project').organizationId)))),
  )
  .post('/projects/:projectId/sample-data', doc('Replace sample data', sampleDataResponseSchema), async (c) => {
    const projectId = c.get('project').id;
    const result = await withProjectLock(projectId, async (tx) => {
      await requireRetentionReady(tx, projectId);
      // Bound sample replacement and rollup rebuild cost.
      const [count] = await (
        await clickhouse.query({
          query: 'SELECT count() n FROM events WHERE project_id={p:String}',
          query_params: { p: projectId },
          format: 'JSONEachRow',
        })
      ).json<{ n: string }>();
      if (Number(count?.n) > 100_000)
        throw new ApiError(409, 'sample_data_limit', 'Sample data is available on projects with at most 100000 stored events.');
      invalidateSetup(projectId);
      const loaded = await loadSampleData(projectId);
      return loaded;
    });
    await audit(c, 'project.sample_data.loaded', { type: 'project', id: projectId });
    return c.json(sampleDataResponseSchema.parse(result));
  })
  .delete('/projects/:projectId/sample-data', routeDoc('Remove sample data', { responses: { 204: { description: 'Removed' } } }), async (c) => {
    const projectId = c.get('project').id;
    await withProjectLock(projectId, async (tx) => {
      await requireRetentionReady(tx, projectId);
      invalidateSetup(projectId);
      await removeSampleData(projectId);
    });
    await audit(c, 'project.sample_data.removed', { type: 'project', id: projectId });
    return c.body(null, 204);
  });
