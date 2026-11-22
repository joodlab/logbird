/**
 * Creates or removes the isolated, fictional project the .NET integration tests use on a local Logbird stack.
 * Run from the repository root with the root .env loaded:
 *   pnpm exec dotenv -e .env -- pnpm exec tsx sdks/dotnet/tests/integration/fixture.ts create <env-file> [endpoint]
 *   pnpm exec dotenv -e .env -- pnpm exec tsx sdks/dotnet/tests/integration/fixture.ts delete <env-file>
 * `create` writes LOGBIRD_IT_* variables (the endpoint, default http://127.0.0.1:4741, and fresh keys) to a NEW
 * <env-file> with owner-only permissions; keep it outside the repository and load it before `dotnet test`. If any
 * step fails, everything it created is removed again.
 * `delete` removes the recorded project with the server's own deletion sequence under one exclusive project lock (fence,
 * stop maintenance, settle in-flight inserts, purge ClickHouse rows and ingest receipts, reconcile, delete), then
 * deletes the fictional workspace only if nothing else (project, member, invitation, link, receipt) is in it. If a
 * recent insert is still settling it fails with ingest_pending and keeps <env-file>: run it again a minute later.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { prisma, withProjectLock } from '@logbird/database';
import {
  clickhouse,
  maintenanceClickhouse,
  purgeProjectEvents,
  queryClickhouse,
  settleProjectInserts,
  stopMaintenance,
} from '../../../../apps/server/src/clickhouse';
import { beginDestructiveMaintenance, reconcileDestructiveMaintenance } from '../../../../apps/server/src/destructive-maintenance';
import { generateApiKey } from '../../../../apps/server/src/keys';

const [command, envFile, endpointArgument] = process.argv.slice(2);
if (!envFile || (command !== 'create' && command !== 'delete')) throw new Error('usage: fixture.ts create|delete <env-file> [endpoint]');
const SLUG_PREFIX = 't4-dotnet-it-';

async function create(file: number) {
  // Keep a path prefix such as https://audit.example.com/logbird; drop only a trailing slash.
  const endpoint = new URL(endpointArgument ?? 'http://127.0.0.1:4741').href.replace(/\/$/, '');
  const suffix = randomUUID().slice(0, 8);
  const orgId = randomUUID();
  try {
    await prisma.organization.create({
      data: { id: orgId, name: `T4 .NET SDK integration ${suffix}`, slug: `${SLUG_PREFIX}${suffix}`, createdAt: new Date() },
    });
    const project = await prisma.project.create({
      data: { organizationId: orgId, name: '.NET SDK integration', slug: 'dotnet-sdk-it', retentionDays: 7 },
    });
    const ingest = generateApiKey('ingest');
    const read = generateApiKey('read');
    await prisma.apiKey.createMany({
      data: [
        { projectId: project.id, name: '.NET SDK integration ingest', kind: 'ingest', hash: ingest.hash, prefix: ingest.prefix },
        { projectId: project.id, name: '.NET SDK integration read', kind: 'read', hash: read.hash, prefix: read.prefix },
      ],
    });
    writeSync(
      file,
      [
        `LOGBIRD_IT_ENDPOINT=${endpoint}`,
        `LOGBIRD_IT_ORG_ID=${orgId}`,
        `LOGBIRD_IT_PROJECT_ID=${project.id}`,
        `LOGBIRD_IT_INGEST_KEY=${ingest.secret}`,
        `LOGBIRD_IT_READ_KEY=${read.secret}`,
        '',
      ].join('\n'),
    );
    console.log(`created fictional project ${project.id} in workspace ${SLUG_PREFIX}${suffix}`);
  } catch (error) {
    // Nothing has been ingested yet, so removing the new workspace (cascading its project and keys) is enough.
    await prisma.organization.deleteMany({ where: { id: orgId, slug: { startsWith: SLUG_PREFIX } } });
    throw error;
  }
}

async function remove() {
  const values = Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('=', 2) as [string, string]),
  );
  const orgId = values.LOGBIRD_IT_ORG_ID;
  const projectId = values.LOGBIRD_IT_PROJECT_ID;
  if (!(orgId && projectId)) throw new Error(`${envFile} does not record a fixture workspace and project`);
  // Guard rails: only ever touch the workspace and project this script created.
  const project = await prisma.project.findFirstOrThrow({ where: { id: projectId, organizationId: orgId }, include: { organization: true } });
  const slug = project.organization.slug;
  if (!slug.startsWith(SLUG_PREFIX)) throw new Error(`refusing to touch workspace ${slug}`);
  // The same sequence the DELETE /api/projects/:projectId route uses, under one exclusive project lock.
  await withProjectLock(projectId, async () => {
    await beginDestructiveMaintenance(projectId);
    await stopMaintenance(projectId);
    await settleProjectInserts(projectId);
    await purgeProjectEvents(projectId, { settled: true });
    await reconcileDestructiveMaintenance(projectId);
    await prisma.project.delete({ where: { id: projectId, organizationId: orgId } });
  });
  // A single conditional statement: if anything else was added to the workspace, it stays with its data.
  const { count } = await prisma.organization.deleteMany({
    where: {
      id: orgId,
      slug: { startsWith: SLUG_PREFIX },
      projects: { none: {} },
      members: { none: {} },
      invitations: { none: {} },
      inviteLinks: { none: {} },
      ingestReceipts: { none: {} },
    },
  });
  rmSync(envFile);
  console.log(
    count === 1
      ? `deleted fictional project ${projectId} and its workspace ${slug}`
      : `deleted fictional project ${projectId}; workspace ${slug} kept because something else was added to it`,
  );
}

try {
  if (command === 'create') {
    // Reserve the file first: exclusive creation never reuses a file another user can read.
    const file = openSync(envFile, 'wx', 0o600);
    let created = false;
    try {
      await create(file);
      created = true;
    } finally {
      closeSync(file);
      if (!created) rmSync(envFile, { force: true });
    }
  } else {
    await remove();
  }
} finally {
  await Promise.allSettled([clickhouse.close(), maintenanceClickhouse.close(), queryClickhouse.close()]);
  await prisma.$disconnect();
}
