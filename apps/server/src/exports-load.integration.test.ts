import { createHmac, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { purgeProject } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { expect, it, vi } from 'vitest';

const trace = vi.hoisted(() => ({ project: '', batch: -1, clocks: [] as unknown[], ctes: [] as unknown[] }));
vi.mock('@logbird/database', async (original) => {
  const db = await original<typeof import('@logbird/database')>();
  return {
    ...db,
    findIngestProject: async (...args: Parameters<typeof db.findIngestProject>) => {
      const result = await db.findIngestProject(...args);
      if (args[1] === trace.project)
        trace.clocks.push({ batch: trace.batch, acceptedAt: result?.acceptedAt.toISOString(), observedAt: new Date().toISOString() });
      return result;
    },
    claimIngestReceipts: async (...args: Parameters<typeof db.claimIngestReceipts>) => {
      if (args[0] !== trace.project) return db.claimIngestReceipts(...args);
      const batch = trace.batch;
      const before = await db.prisma.exportLease.findMany({
        where: { projectId: trace.project },
        select: { id: true, receivedBefore: true, invalidated: true },
      });
      const result = await db.claimIngestReceipts(...args);
      const after = await db.prisma.exportLease.findMany({
        where: { projectId: trace.project },
        select: { id: true, receivedBefore: true, invalidated: true },
      });
      trace.ctes.push({
        batch,
        count: args[2].length,
        minReceivedAt: args[2].map((row) => row.receivedAt.toISOString()).sort()[0],
        maxReceivedAt: args[2]
          .map((row) => row.receivedAt.toISOString())
          .sort()
          .at(-1),
        before,
        after,
      });
      expect(after.some((row) => row.invalidated)).toBe(false);
      return result;
    },
  };
});

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
  const batchTimings: { batch: number; startedAt: string; completedAt: string; elapsedMs: number }[] = [];
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
    trace.project = projectId;
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
        trace.batch = batches;
        const events = Array.from({ length: batchSize }, (_, i) => ({ id: `${prefix}-load-${batches}-${i}`, action: 'qa.export.load' }));
        const startedAt = new Date().toISOString(),
          started = performance.now();
        expect((await ingest(projectId, events)).accepted).toBe(batchSize);
        batchTimings.push({ batch: batches, startedAt, completedAt: new Date().toISOString(), elapsedMs: performance.now() - started });
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
        reason: outcome?.reason ?? (response.status !== 200 ? (JSON.parse(text).error?.code ?? null) : null),
        readComplete,
        elapsedMs: performance.now() - started,
      });
    }
    stop = true;
    await writer;
    if (writerError) throw writerError;
    const completed = outcomes.filter((row) => row.status === 200 && row.state === 'completed' && row.readComplete).length;
    const metrics = {
      event: 'qa.export_busy_project',
      trials,
      completed,
      successRate: completed / trials,
      writerConcurrency: 1,
      batchSize,
      batches,
      outcomes,
      batchTimings,
      telemetry: {
        clockSource:
          'acceptance: Postgres clock_timestamp() inside shared project lock, greater than max active fence by at least 1ms; export: frozen API Date.now()',
        clocks: trace.clocks,
        ctes: trace.ctes,
        instrumentation: 'two test-only lease snapshots per batch; production adds zero PG round trips',
      },
    };
    console.log(JSON.stringify(metrics));
    if (process.env.LOGBIRD_EXPORT_PROOF_DIR)
      writeFileSync(path.join(process.env.LOGBIRD_EXPORT_PROOF_DIR, 'exports-load-metrics.json'), JSON.stringify(metrics, null, 2));
    expect(completed).toBeGreaterThan(0);
    expect(outcomes.some((row) => row.reason === 'membership_changed')).toBe(false);
  } finally {
    stop = true;
    await writer;
    await drainExportAudits();
    if (projectId) {
      await purgeProject(clickhouse, projectId);
      await prisma.exportLease.deleteMany({ where: { projectId } });
    }
    await prisma.ingestReceipt.deleteMany({ where: { projectId } });
    await purgeProject(clickhouse, `ws:${org}`);
    await prisma.ingestReceipt.deleteMany({ where: { projectId: `ws:${org}` } });
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${org}` } });
    await prisma.organization.deleteMany({ where: { id: org } });
    await prisma.user.deleteMany({ where: { id: user } });
  }
}, 360_000);
