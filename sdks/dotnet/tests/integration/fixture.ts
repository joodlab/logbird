/**
 * Creates or removes the isolated, fictional project the .NET integration tests use on a local Logbird stack.
 * Run from the repository root with the root .env loaded:
 *   pnpm exec dotenv -e .env -- pnpm exec tsx sdks/dotnet/tests/integration/fixture.ts create <env-file>
 *   pnpm exec dotenv -e .env -- pnpm exec tsx sdks/dotnet/tests/integration/fixture.ts delete <env-file>
 * `create` writes LOGBIRD_IT_* variables (including fresh keys) to <env-file>; keep that file outside the repository.
 * `delete` purges the project's ClickHouse rows under the project lock and deletes the fictional workspace.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createClickHouseClient, purgeProject } from '@logbird/clickhouse';
import { prisma, withProjectLock } from '@logbird/database';
import { generateApiKey } from '../../../../apps/server/src/keys';

const [command, envFile] = process.argv.slice(2);
if (!envFile || (command !== 'create' && command !== 'delete')) throw new Error('usage: fixture.ts create|delete <env-file>');
const SLUG_PREFIX = 't4-dotnet-it-';

try {
  if (command === 'create') {
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
    writeFileSync(
      envFile,
      [
        `LOGBIRD_IT_ORG_ID=${org.id}`,
        `LOGBIRD_IT_PROJECT_ID=${project.id}`,
        `LOGBIRD_IT_INGEST_KEY=${ingest.secret}`,
        `LOGBIRD_IT_READ_KEY=${read.secret}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    console.log(`created fictional project ${project.id} in workspace ${org.slug}`);
  } else {
    const values = Object.fromEntries(
      readFileSync(envFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('=', 2) as [string, string]),
    );
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: values.LOGBIRD_IT_ORG_ID }, include: { projects: true } });
    // Guard rail: only ever delete a workspace this script created.
    if (!org.slug.startsWith(SLUG_PREFIX)) throw new Error(`refusing to delete workspace ${org.slug}`);
    const ch = createClickHouseClient();
    for (const project of org.projects) await withProjectLock(project.id, () => purgeProject(ch, project.id));
    await ch.close();
    await prisma.organization.delete({ where: { id: org.id } });
    rmSync(envFile);
    console.log(`deleted fictional workspace ${org.slug} and ${org.projects.length} project(s)`);
  }
} finally {
  await prisma.$disconnect();
}
