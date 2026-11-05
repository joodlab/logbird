import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { insertEvents, normalizeEvent } from '@trailmark/clickhouse';
import { ingestResponseSchema } from '@trailmark/contracts';
import { prisma, RETENTION_LEASE_MS, recoverAbandonedRetention, withProjectLock } from '@trailmark/database';
import { enqueueProjectRetention } from '@trailmark/worker/queue';
import type { Context } from 'hono';
import { clickhouse } from './clickhouse';
import { ApiError } from './errors';
import { invalidateSetup } from './setup-cache';
import type { AppEnv } from './types';

export async function readIngestBody(request: Request): Promise<unknown> {
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding !== 'gzip' && encoding !== 'identity') throw new ApiError(415, 'unsupported_encoding', 'Use gzip or identity.');
  if (!request.body) throw new ApiError(400, 'invalid_json', 'A JSON body is required.');
  const source = Readable.fromWeb(request.body as import('node:stream/web').ReadableStream);
  const body = encoding === 'gzip' ? source.pipe(createGunzip()) : source;
  if (body !== source) source.on('error', (error) => body.destroy(error));
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) throw new ApiError(413, 'payload_too_large', 'Request exceeds 5 MB.');
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json', 'Invalid JSON or gzip body.');
  } finally {
    body.destroy();
    source.destroy();
  }
}
export async function ingest(projectId: string, body: unknown, sdk = '') {
  const events = Array.isArray(body) ? body : body && typeof body === 'object' && 'events' in body ? (body as { events: unknown }).events : [body];
  if (!Array.isArray(events) || !events.length) throw new ApiError(422, 'validation_error', 'events must be a nonempty array.');
  if (events.length > 1000 || events.some((e) => Buffer.byteLength(JSON.stringify(e)) > 256 * 1024))
    throw new ApiError(413, 'payload_too_large', 'Maximum 1000 events and 256 KB per event.');
  const rows: import('@trailmark/clickhouse').EventRow[] = [],
    ids: string[] = [],
    rejected: { index: number; reason: string }[] = [],
    warnings: { index: number; reason: string }[] = [];
  for (const [index, event] of events.entries()) {
    const normalized = normalizeEvent(event, { projectId, receivedAt: new Date(), sdk });
    if (normalized.ok) {
      rows.push(normalized.row);
      ids.push(normalized.id);
      if (normalized.warning) warnings.push({ index, reason: normalized.warning });
    } else rejected.push({ index, reason: normalized.reason });
  }
  await withProjectLock(
    projectId,
    async (tx) => {
      if (!projectId.startsWith('ws:') && !(await tx.project.findUnique({ where: { id: projectId } })))
        throw new ApiError(404, 'not_found', 'Project not found.');
      await requireRetentionReady(tx, projectId);
      try {
        await insertEvents(clickhouse, rows);
      } catch (error) {
        if (error instanceof Error && 'code' in error && ['6', '27', '38', '41', '53', '69', '72'].includes(String(error.code)))
          throw new ApiError(422, 'invalid_event', 'Storage could not parse this batch. Check event field types and timestamps.');
        throw error;
      }
      invalidateSetup(projectId);
      // Shared: concurrent ingests (several app servers, SDK flushes, audit writes) coexist; maintenance excludes them.
    },
    { mode: 'shared' },
  );
  return ingestResponseSchema.parse({ accepted: ids.length, ids, rejected, warnings });
}
export function audit(c: Context<AppEnv>, action: string, target: { type: string; id: string; name?: string }, changes?: unknown[]) {
  return ingest(`ws:${c.get('activeOrganizationId')}`, {
    action,
    occurredAt: new Date().toISOString(),
    actor: { type: 'user', ...c.get('user'), name: c.get('user').name || c.get('user').email },
    executor: { type: 'api', id: 'api-server' },
    targets: [target],
    changes,
    description: action,
    context: { requestId: c.get('requestId'), ip: c.req.header('x-forwarded-for') ?? '', userAgent: c.req.header('user-agent') ?? '' },
  });
}

export async function requireRetentionReady(tx: import('@trailmark/database').Prisma.TransactionClient, projectId: string) {
  const recovered = await recoverAbandonedRetention(tx, projectId);
  if (recovered.count) await enqueueProjectRetention(projectId);
  const latest = await tx.retentionRun.findFirst({ where: { projectId, status: 'running' } });
  if (latest) throw new ApiError(503, 'retention_unavailable', 'Retention rebuild must complete before accessing project data.');
}

/** Reads use short statements only; stale recovery alone needs a non-blocking project lock. */
export async function requireProjectReadable(projectId: string) {
  const run = await prisma.retentionRun.findFirst({ where: { projectId, status: 'running' }, orderBy: { startedAt: 'desc' } });
  if (!run) return;
  if ((run.heartbeatAt ?? run.startedAt).getTime() >= Date.now() - RETENTION_LEASE_MS)
    throw new ApiError(503, 'retention_unavailable', 'Retention rebuild is in progress. Retry shortly.');
  await withProjectLock(projectId, (db) => requireRetentionReady(db, projectId));
}
