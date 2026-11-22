/**
 * Creates or removes the isolated, fictional project the .NET integration tests use on a local Logbird stack.
 * Run from the repository root with the root .env loaded:
 *   pnpm exec dotenv -e .env -- pnpm exec tsx sdks/dotnet/tests/integration/fixture.ts create <env-file> [endpoint]
 *   pnpm exec dotenv -e .env -- pnpm exec tsx sdks/dotnet/tests/integration/fixture.ts delete <env-file>
 * `create` writes LOGBIRD_IT_* variables (the endpoint, default http://127.0.0.1:4741, and fresh keys) to a NEW
 * <env-file> with owner-only permissions; keep it outside the repository and load it before `dotnet test`.
 * `delete` purges only the recorded project's ClickHouse rows under the project lock, deletes that project, and
 * deletes the fictional workspace only if nothing else was added to it.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { createClickHouseClient, purgeProject } from '@logbird/clickhouse';
import { prisma, withProjectLock } from '@logbird/database';
import { generateApiKey } from '../../../../apps/server/src/keys';

const [command, envFile, endpointArgument] = process.argv.slice(2);
if (!envFile || (command !== 'create' && command !== 'delete')) throw new Error('usage: fixture.ts create|delete <env-file> [endpoint]');
const SLUG_PREFIX = 't4-dotnet-it-';

try {
  if (command === 'create') {
    const endpoint = new URL(endpointArgument ?? 'http://127.0.0.1:4741').origin;
    // Reserve the file first: exclusive creation never reuses a file another user can read, and a failure here leaves
    // no fixture workspace behind.
    const file = openSync(envFile, 'wx', 0o600);
    try {
      const suffix = randomUUID().slice(0, 8);
      const org = await prisma.organization.create({
        data: { id: randomUUID(), name: `T4 .NET SDK integration ${suffix}`, slug: `${SLUG_PREFIX}${suffix}`, createdAt: new Date() },
      });
      const project = await prisma.project.create({
        data: { organizationId: org.id, name: '.NET SDK integration', slug: 'dotnet-sdk-it', retentionDays: 7 },
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
          `LOGBIRD_IT_ORG_ID=${org.id}`,
          `LOGBIRD_IT_PROJECT_ID=${project.id}`,
          `LOGBIRD_IT_INGEST_KEY=${ingest.secret}`,
          `LOGBIRD_IT_READ_KEY=${read.secret}`,
          '',
        ].join('\n'),
      );
      console.log(`created fictional project ${project.id} in workspace ${org.slug}`);
    } finally {
      closeSync(file);
    }
  } else {
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
    if (!project.organization.slug.startsWith(SLUG_PREFIX)) throw new Error(`refusing to touch workspace ${project.organization.slug}`);
    const ch = createClickHouseClient();
    await withProjectLock(projectId, () => purgeProject(ch, projectId));
    await ch.close();
    const removedWorkspace = await prisma.$transaction(async (tx) => {
      await tx.project.delete({ where: { id: projectId, organizationId: orgId } });
      // A single conditional statement: anything added to the workspace meanwhile keeps it (and its data) intact.
      const { count } = await tx.organization.deleteMany({
        where: { id: orgId, slug: { startsWith: SLUG_PREFIX }, projects: { none: {} }, members: { none: {} } },
      });
      return count === 1;
    });
    rmSync(envFile);
    console.log(
      removedWorkspace
        ? `deleted fictional project ${projectId} and its workspace ${project.organization.slug}`
        : `deleted fictional project ${projectId}; workspace ${project.organization.slug} kept because something else was added to it`,
    );
  }
} finally {
  await prisma.$disconnect();
}
