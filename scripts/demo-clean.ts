/**
 * Remove what QA / smoke / e2e runs leave behind so the local demo looks pristine.
 *
 *   pnpm demo:clean          dry run: prints the plan, changes nothing
 *   pnpm demo:clean --yes    applies it
 *   pnpm demo:clean --yes --orphans   also purges orphaned ClickHouse projects (see below)
 *
 * Only throwaway data is matched:
 * - users whose email matches THROWAWAY_EMAIL (newcomer-*, ui-smoke-*, smoke-*, e2e-*, invite(d)-*, foundation-*, qa-*
 *   at logbird.local / example.test), with their sessions, accounts and pending verifications;
 * - workspaces whose every member is such a user (plus "Smoke fixture" workspaces left without members), with their
 *   projects, keys, views, retention runs and ClickHouse rows (events + rollups + workspace activity);
 * - named smoke projects (SMOKE_PROJECT) inside kept workspaces, e.g. "Backend gaps <uuid>" inside "Acme", and the
 *   workspace-activity rows about them or written by throwaway users;
 * - with --orphans only: ClickHouse rows of projects that no longer exist in Postgres (deleted orgs, aborted test
 *   runs, old seed sinks such as seed-staydesk-dev). They are listed in every dry run.
 * The demo user, the "Acme" workspace and its StayDesk / Ledger demo projects are protected: the script refuses to
 * run if the plan would touch them, and it never changes retention. ClickHouse deletes are always project-scoped and
 * run under the project lock: whole projects go through `purgeProject` (the same code retention and project deletion
 * use); activity rows in kept workspaces use the same verified delete (`deleteAndVerify`) on raw events only. That
 * targeted delete keeps the rows' event_ids pointers (harmless: lookups fall back to raw rows) and ingest receipts
 * (harmless: these random-id workspace-activity events are never resent) and
 * does not rebuild the workspace's rollups, so entity/attribute counts there can stay slightly high.
 */
import { parseArgs } from 'node:util';
import { createClickHouseClient, deleteAndVerify, purgeProject } from '@logbird/clickhouse';
import { prisma, withProjectLock } from '@logbird/database';

export const THROWAWAY_EMAIL = /^(newcomer|ui-smoke|smoke|e2e|invite|invited|foundation|qa)-[\w.+-]*@(logbird\.local|example\.test)$/i;
export const SMOKE_PROJECT = [/^Backend gaps [0-9a-f-]{36}$/i, /^Smoke (project|fixture)$/i];
const SMOKE_WORKSPACE = /^Smoke fixture$/i;
const PROTECTED = { email: 'demo@logbird.local', orgSlug: 'acme', projectSlugs: ['staydesk', 'ledger-demo'] };

const { values } = parseArgs({ options: { yes: { type: 'boolean', default: false }, orphans: { type: 'boolean', default: false } } });
const apply = values.yes;
const ch = createClickHouseClient();

async function chCount(query: string, params: Record<string, unknown>) {
  const rows = await (await ch.query({ query, query_params: params, format: 'JSONEachRow' })).json<{ n: string }>();
  return Number(rows[0]?.n ?? 0);
}
const eventCount = (projectId: string) => chCount('SELECT count() n FROM events WHERE project_id={p:String}', { p: projectId });

try {
  const users = (await prisma.user.findMany({ select: { id: true, email: true, name: true } })).filter((u) => THROWAWAY_EMAIL.test(u.email));
  const userIds = new Set(users.map((u) => u.id));

  const orgs = await prisma.organization.findMany({ include: { members: { select: { userId: true } }, projects: true } });
  const dropOrgs = orgs.filter((o) => (o.members.length ? o.members.every((m) => userIds.has(m.userId)) : SMOKE_WORKSPACE.test(o.name)));
  const keptOrgs = orgs.filter((o) => !dropOrgs.includes(o));
  const dropProjects = keptOrgs.flatMap((o) => o.projects.filter((p) => SMOKE_PROJECT.some((re) => re.test(p.name))).map((p) => ({ ...p, org: o })));
  const invitations = await prisma.invitation.findMany({
    where: { organizationId: { in: keptOrgs.map((o) => o.id) } },
    select: { id: true, email: true, organizationId: true },
  });
  const dropInvitations = invitations.filter((i) => THROWAWAY_EMAIL.test(i.email));

  // Guard rails: none of this may ever touch the demo.
  if (users.some((u) => u.email === PROTECTED.email)) throw new Error('Refusing: the demo user matched the throwaway pattern.');
  if (dropOrgs.some((o) => o.slug === PROTECTED.orgSlug)) throw new Error('Refusing: the Acme workspace matched.');
  if (dropProjects.some((p) => PROTECTED.projectSlugs.includes(p.slug))) throw new Error('Refusing: a demo project matched.');

  // ClickHouse rows that no Postgres project or workspace owns any more.
  const known = new Set([...orgs.flatMap((o) => o.projects.map((p) => p.id)), ...orgs.map((o) => `ws:${o.id}`)]);
  const stored = await (await ch.query({ query: 'SELECT project_id, count() n FROM events GROUP BY project_id', format: 'JSONEachRow' })).json<{
    project_id: string;
    n: string;
  }>();
  const orphans = stored.filter((r) => !known.has(r.project_id));

  // Workspace-activity rows in kept workspaces about removed projects, or written by removed users.
  const activity = await Promise.all(
    keptOrgs.map(async (o) => {
      const params = { p: `ws:${o.id}`, targets: dropProjects.filter((p) => p.org.id === o.id).map((p) => p.id), actors: [...userIds] };
      const where = 'project_id={p:String} AND (hasAny(target_ids,{targets:Array(String)}) OR actor_id IN {actors:Array(String)})';
      return {
        org: o,
        params,
        where,
        n: params.targets.length || params.actors.length ? await chCount(`SELECT count() n FROM events WHERE ${where}`, params) : 0,
      };
    }),
  );

  const plan = {
    mode: apply ? 'apply' : 'dry-run',
    users: users.map((u) => u.email),
    workspaces: await Promise.all(
      dropOrgs.map(async (o) => ({
        name: o.name,
        projects: await Promise.all(o.projects.map(async (p) => ({ name: p.name, events: await eventCount(p.id) }))),
        activityEvents: await eventCount(`ws:${o.id}`),
      })),
    ),
    smokeProjects: await Promise.all(dropProjects.map(async (p) => ({ workspace: p.org.name, name: p.name, events: await eventCount(p.id) }))),
    invitations: dropInvitations.map((i) => i.email),
    activityRows: activity.filter((a) => a.n).map((a) => ({ workspace: a.org.name, events: a.n })),
    orphanedClickHouseProjects: {
      purged: Boolean(values.orphans),
      projects: orphans.map((r) => ({ projectId: r.project_id, events: Number(r.n) })),
    },
    kept: keptOrgs.map((o) => ({
      workspace: o.name,
      projects: o.projects.filter((p) => !dropProjects.some((d) => d.id === p.id)).map((p) => p.name),
    })),
  };
  console.log(JSON.stringify(plan, null, 2));
  if (!apply) {
    console.log('\nDry run: nothing changed. Re-run with --yes to apply.');
  } else {
    const purge = (projectId: string) => withProjectLock(projectId, () => purgeProject(ch, projectId));
    for (const p of dropProjects) {
      await purge(p.id);
      await prisma.project.delete({ where: { id: p.id } });
    }
    for (const o of dropOrgs) {
      for (const p of o.projects) await purge(p.id);
      await purge(`ws:${o.id}`);
      await prisma.organization.delete({ where: { id: o.id } }); // cascades members, invitations, projects, keys, views, runs
    }
    if (values.orphans) for (const r of orphans) await purge(r.project_id);
    for (const a of activity) {
      if (!a.n) continue;
      const filter = 'hasAny(target_ids,{targets:Array(String)}) OR actor_id IN {actors:Array(String)}';
      const { targets, actors } = a.params;
      await withProjectLock(a.params.p, () => deleteAndVerify(ch, a.params.p, 'events', filter, { targets, actors }));
    }
    if (dropInvitations.length) await prisma.invitation.deleteMany({ where: { id: { in: dropInvitations.map((i) => i.id) } } });
    if (users.length) {
      await prisma.verification.deleteMany({ where: { OR: users.map((u) => ({ identifier: { contains: u.email } })) } });
      await prisma.user.deleteMany({ where: { id: { in: [...userIds] } } }); // cascades sessions, accounts, memberships
    }
    console.log('\nApplied.');
  }
} finally {
  await ch.close();
  await prisma.$disconnect();
}
