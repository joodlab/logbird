import { createHmac, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { purgeProject } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { expect, it } from 'vitest';
import { app } from './app';
import { clickhouse } from './clickhouse';
import { env } from './env';
import { getExportStatus } from './export-outcomes';
import { drainExportAudits } from './export-stream';
import { ingest } from './ingest';

it('measures actual export outcomes during bounded c1-like ingestion in one fictional project', async () => {
  const user = randomUUID(),
    org = `qa-export-busy-${randomUUID()}`,
    token = randomUUID(),
    prefix = randomUUID();
  const outcomes: { status: number; state: string; reason: string | null; readComplete: boolean; elapsedMs: number }[] = [];
  let projectId = '',
    stop = false,
    batches = 0;
  let writer: Promise<void> | undefined;
  let writerError: unknown;
  const batchSize = 1000,
    trials = 12;
  try {
    await prisma.user.create({ data: { id: user, name: 'QA Export busy project', email: `qa-export-busy-${user}@example.test` } });
    await prisma.organization.create({
      data: {
        id: org,
        name: 'QA Export busy project',
        slug: org,
        createdAt: new Date(),
        members: { create: { id: randomUUID(), userId: user, role: 'owner', createdAt: new Date() } },
      },
    });
    await prisma.session.create({
      data: { id: randomUUID(), userId: user, token, activeOrganizationId: org, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const project = await prisma.project.create({ data: { name: 'QA Export c1-like ingest', slug: 'c1-like-ingest', organizationId: org } });
    projectId = project.id;
    const cookie = `logbird.session_token=${encodeURIComponent(`${token}.${createHmac('sha256', env.BETTER_AUTH_SECRET).update(token).digest('base64')}`)}`;
    expect(
      (
        await ingest(
          projectId,
          Array.from({ length: 401 }, (_, i) => ({ id: `${prefix}-seed-${i}`, action: 'qa.export.member' })),
        )
      ).accepted,
    ).toBe(401);
    let warmed!: () => void;
    const warm = new Promise<void>((resolve) => {
      warmed = resolve;
    });
    // One serial writer, full 1000-event batches, no artificial think time, at most 50,000 new fixture events.
    writer = (async () => {
      for (; !stop && batches < 50; batches++) {
        const events = Array.from({ length: batchSize }, (_, i) => ({ id: `${prefix}-load-${batches}-${i}`, action: 'qa.export.load' }));
        expect((await ingest(projectId, events)).accepted).toBe(batchSize);
        warmed();
      }
    })().catch((error) => {
      writerError = error;
      warmed();
    });
    await Promise.race([warm, writer]);
    if (writerError) throw writerError;
    for (let trial = 0; trial < trials; trial++) {
      const started = performance.now();
      const response = await app.request(`/api/projects/${projectId}/export?format=jsonl&q=action:qa.export.member`, { headers: { cookie } });
      let readComplete = false,
        text = '';
      try {
        text = await response.text();
        readComplete = true;
      } catch {
        /* Recorded below; partial files are never accepted. */
      }
      await drainExportAudits();
      const id = response.headers.get('X-Logbird-Export-Id');
      const outcome = id ? await getExportStatus(id, `ws:${org}`).catch(() => null) : null;
      const completed = response.status === 200 && readComplete && outcome?.state === 'completed';
      if (completed)
        expect(
          new Set(
            text
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line).id),
          ).size,
        ).toBe(401);
      outcomes.push({
        status: response.status,
        state: outcome?.state ?? 'not_admitted',
        reason: outcome?.reason ?? null,
        readComplete,
        elapsedMs: performance.now() - started,
      });
    }
    stop = true;
    await writer;
    if (writerError) throw writerError;
    const completed = outcomes.filter((row) => row.status === 200 && row.state === 'completed' && row.readComplete).length;
    expect(completed).toBeGreaterThan(0);
    const metrics = {
      event: 'qa.export_busy_project',
      trials,
      completed,
      successRate: completed / trials,
      writerConcurrency: 1,
      batchSize,
      batches,
      outcomes,
    };
    console.log(JSON.stringify(metrics));
    if (process.env.LOGBIRD_EXPORT_PROOF_DIR)
      writeFileSync(path.join(process.env.LOGBIRD_EXPORT_PROOF_DIR, 'exports-load-metrics.json'), JSON.stringify(metrics, null, 2));
  } finally {
    stop = true;
    await writer;
    await drainExportAudits();
    if (projectId) {
      await purgeProject(clickhouse, projectId);
      await prisma.exportLease.deleteMany({ where: { projectId } });
    }
    await purgeProject(clickhouse, `ws:${org}`);
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${org}` } });
    await prisma.organization.deleteMany({ where: { id: org } });
    await prisma.user.deleteMany({ where: { id: user } });
  }
}, 360_000);
