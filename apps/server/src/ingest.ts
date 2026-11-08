import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { normalizeEvent } from '@logbird/clickhouse';
import { ingestPendingDetailsSchema, ingestResponseSchema } from '@logbird/contracts';
import { prisma, RETENTION_LEASE_MS, recoverAbandonedRetention, withProjectLock } from '@logbird/database';
import { logIngestRecoveryFailure, recoverProjectIngest } from '@logbird/worker/ingest-recovery';
import { enqueueProjectRetention } from '@logbird/worker/queue';
import type { Context } from 'hono';
import { queueAuditEvent } from './audit-outbox';
import { maintenanceClickhouse } from './clickhouse';
import { ApiError } from './errors';
import { type IngestCandidate, insertImmutableEvents } from './immutable-ingest';
import { clientAddress } from './rate-limit';
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
  const candidates: IngestCandidate[] = [],
    ids: string[] = [],
    rejected: { index: number; reason: string; code: string }[] = [],
    warnings: { index: number; reason: string }[] = [];
  for (const [index, event] of events.entries()) {
    const normalized = normalizeEvent(event, { projectId, receivedAt: new Date(), sdk });
    if (normalized.ok) {
      // Internal audit callers can pass Dates/toJSON values; identity is always the parsed wire payload.
      candidates.push({ index, input: JSON.parse(normalized.row.payload), row: normalized.row });
      if (normalized.warning) warnings.push({ index, reason: normalized.warning });
    } else {
      const code = normalized.reason.startsWith('invalid_event_id:') ? 'invalid_event_id' : 'invalid_event';
      rejected.push({ index, reason: normalized.reason.startsWith(`${code}:`) ? normalized.reason : `${code}: ${normalized.reason}`, code });
    }
  }
  const store = async (tx: import('@logbird/database').Prisma.TransactionClient) => {
    const project = projectId.startsWith('ws:') ? null : await tx.project.findUnique({ where: { id: projectId } });
    if (!projectId.startsWith('ws:') && !project) throw new ApiError(404, 'not_found', 'Project not found.');
    await requireRetentionReady(tx, projectId);
    const result = await insertImmutableEvents(projectId, organizationIdForStream(projectId, project?.organizationId), candidates);
    ids.push(...result.ids);
    rejected.push(...result.rejected);
    invalidateSetup(projectId);
  };
  let replayed = false,
    replayStarted = false;
  try {
    replayed = await recoverProjectIngest(maintenanceClickhouse, projectId, {
      eventIds: candidates.map((c) => c.row.event_id),
      replay: () => {
        replayStarted = true;
        return store(prisma);
      },
      candidates: candidates.map((c) => ({ input: c.input, eventId: c.row.event_id })),
    });
  } catch (error) {
    if (replayStarted) {
      if (error instanceof ApiError) throw settledDetails(error, rejected, warnings);
      throw new ApiError(503, 'ingest_unavailable', 'Event storage is unavailable. Retry this batch.');
    }
    logIngestRecoveryFailure(error, projectId);
    // Expired ids remain fenced; the shared phase can still commit healthy siblings.
  }
  // Healthy traffic remains concurrent. Only an expired/worker-readied replay holds the exclusive lock through INSERT.
  if (!replayed) {
    try {
      await withProjectLock(projectId, store, { mode: 'shared' });
    } catch (error) {
      if (error instanceof ApiError) throw settledDetails(error, rejected, warnings);
      throw error;
    }
  }
  return ingestResponseSchema.parse({ accepted: ids.length, ids, rejected, warnings });
}
function organizationIdForStream(projectId: string, organizationId?: string) {
  return organizationId ?? projectId.slice('ws:'.length);
}
export function audit(
  c: Context<AppEnv>,
  action: string,
  target: { type: string; id: string; name?: string },
  changes?: unknown[],
  extra?: {
    targets?: { type: string; id: string; name?: string }[];
    metadata?: import('@logbird/database').Prisma.InputJsonObject;
    description?: string;
    organizationId?: string;
  },
  tx?: import('@logbird/database').Prisma.TransactionClient,
) {
  return queueAuditEvent(
    `ws:${extra?.organizationId ?? c.get('activeOrganizationId')}`,
    {
      action,
      occurredAt: new Date().toISOString(),
      actor: { type: 'user', id: c.get('user').id, name: c.get('user').name || c.get('user').email },
      executor: { type: 'api', id: 'api-server' },
      targets: extra?.targets ?? [target],
      changes: changes as import('@logbird/database').Prisma.InputJsonValue[],
      metadata: extra?.metadata,
      description: extra?.description ?? action,
      context: { requestId: c.get('requestId'), ip: clientAddress(c) ?? '', userAgent: c.req.header('user-agent') ?? '' },
    },
    tx,
  );
}

export async function requireRetentionReady(tx: import('@logbird/database').Prisma.TransactionClient, projectId: string) {
  const recovered = await recoverAbandonedRetention(tx, projectId);
  if (recovered.count) await enqueueProjectRetention(projectId);
  const latest = await tx.retentionRun.findFirst({ where: { projectId, kind: 'retention', status: 'running' } });
  if (latest) throw new ApiError(503, 'retention_unavailable', 'Project data is being rebuilt. Retry shortly.');
}

/** Reads use short statements only; stale recovery alone needs a non-blocking project lock. */
export async function requireProjectReadable(projectId: string) {
  const run = await prisma.retentionRun.findFirst({
    where: { projectId, OR: [{ status: 'running' }, { kind: 'ingest_repair', status: 'failed' }] },
    orderBy: { startedAt: 'desc' },
  });
  if (!run) return;
  if (run.kind === 'ingest_repair' && run.status === 'failed')
    throw new ApiError(503, 'retention_unavailable', 'Project data is being rebuilt. Retry shortly.');
  if ((run.heartbeatAt ?? run.startedAt).getTime() >= Date.now() - RETENTION_LEASE_MS)
    throw new ApiError(503, 'retention_unavailable', 'Project data is being rebuilt. Retry shortly.');
  await withProjectLock(projectId, async (db) => {
    await requireRetentionReady(db, projectId);
    if (await db.retentionRun.findFirst({ where: { projectId, kind: 'ingest_repair', status: { in: ['running', 'failed'] } } }))
      throw new ApiError(503, 'retention_unavailable', 'Project data is being rebuilt. Retry shortly.');
  });
}

function settledDetails(error: ApiError, rejected: { index: number; reason: string; code: string }[], warnings: { index: number; reason: string }[]) {
  if (error.code !== 'ingest_pending') return error;
  const details = ingestPendingDetailsSchema.parse(error.details);
  return new ApiError(
    503,
    error.code,
    error.message,
    ingestPendingDetailsSchema.parse({ ...details, rejected: [...rejected, ...details.rejected], warnings }),
    error.retryAfter,
  );
}
