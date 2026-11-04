import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { insertEvents, normalizeEvent } from '@trailmark/clickhouse';
import { ingestResponseSchema } from '@trailmark/contracts';
import { withProjectLock } from '@trailmark/database';
import type { Context } from 'hono';
import { clickhouse } from './clickhouse';
import { ApiError } from './errors';
import type { AppEnv } from './types';

export async function readIngestBody(request: Request): Promise<unknown> {
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding !== 'gzip' && encoding !== 'identity') throw new ApiError(415, 'unsupported_encoding', 'Use gzip or identity.');
  if (!request.body) throw new ApiError(400, 'invalid_json', 'A JSON body is required.');
  const source = Readable.fromWeb(request.body as import('node:stream/web').ReadableStream);
  const body = encoding === 'gzip' ? source.pipe(createGunzip()) : source;
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
  const events = body && typeof body === 'object' && 'events' in body ? (body as { events: unknown }).events : [body];
  if (!Array.isArray(events) || !events.length) throw new ApiError(422, 'validation_error', 'events must be a nonempty array.');
  if (events.length > 1000 || events.some((e) => Buffer.byteLength(JSON.stringify(e)) > 256 * 1024))
    throw new ApiError(413, 'payload_too_large', 'Maximum 1000 events and 256 KB per event.');
  const rows: import('@trailmark/clickhouse').EventRow[] = [],
    ids: string[] = [],
    rejected: { index: number; reason: string }[] = [];
  for (const [index, event] of events.entries()) {
    const normalized = normalizeEvent(event, { projectId, receivedAt: new Date(), sdk });
    if (normalized.ok) {
      rows.push(normalized.row);
      ids.push(normalized.id);
    } else rejected.push({ index, reason: normalized.reason });
  }
  await withProjectLock(projectId, async (tx) => {
    if (!projectId.startsWith('ws:') && !(await tx.project.findUnique({ where: { id: projectId } })))
      throw new ApiError(404, 'not_found', 'Project not found.');
    const failed = await tx.retentionRun.findFirst({ where: { projectId, status: { in: ['failed', 'running'] } }, orderBy: { startedAt: 'desc' } });
    const latest = failed && (await tx.retentionRun.findFirst({ where: { projectId }, orderBy: { startedAt: 'desc' } }));
    if (latest && latest.status !== 'completed')
      throw new ApiError(503, 'retention_unavailable', 'Retention rebuild must complete before ingestion.');
    await insertEvents(clickhouse, rows);
  });
  return ingestResponseSchema.parse({ accepted: ids.length, ids, rejected });
}
export function audit(c: Context<AppEnv>, action: string, target: { type: string; id: string; name?: string }, changes?: unknown[]) {
  return ingest(`ws:${c.get('activeOrganizationId')}`, {
    action,
    occurredAt: new Date().toISOString(),
    actor: { type: 'user', ...c.get('user') },
    executor: { type: 'api', id: 'api-server' },
    targets: [target],
    changes,
    description: action,
    context: { requestId: c.get('requestId'), ip: c.req.header('x-forwarded-for') ?? '', userAgent: c.req.header('user-agent') ?? '' },
  });
}
