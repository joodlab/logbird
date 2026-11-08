import { randomUUID } from 'node:crypto';
import * as ch from '@logbird/clickhouse';
import * as s from '@logbird/contracts';
import { type AuditPayload, type Prisma, prisma } from '@logbird/database';
import { type Context, Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { resolver, validator } from 'hono-openapi';
import { z } from 'zod';
import { cancelExportQuery, clickhouse, queryClickhouse } from './clickhouse';
import { ApiError } from './errors';
import { startExportHeartbeat } from './export-lifecycle';
import {
  confirmExportOutcome,
  finishExport,
  getExportStatus,
  releaseExportAdmission,
  renewExport,
  stageExport,
  validateExportMembership,
} from './export-outcomes';
import { auditedExport } from './export-stream';
import { ingest, readIngestBody, requireProjectReadable } from './ingest';
import { requireApiKey, requireProjectAccess, requireSession } from './middlewares';
import { doc as responseDoc, routeDoc } from './openapi';
import { deliverOutboxEvent, waitForAuditDelivery } from './outbox-delivery';
import { clientAddress, publicRateLimits } from './rate-limit';
import type { AppEnv } from './types';

const ingestRequestSchema = (await resolver(s.ingestBodySchema).toOpenAPISchema()).schema;

const doc = (summary: string, schema: z.ZodType, status = 200, security = 'session') =>
  summary === 'Ingest events'
    ? routeDoc(
        summary,
        {
          requestBody: {
            required: true,
            description: 'Single event or batch. Gzip supported; 1000 events, 5 MiB decoded body, 256 KiB per event.',
            content: { 'application/json': { schema: ingestRequestSchema, example: { action: 'document.updated' } } },
          },
          responses: { [status]: { description: summary, content: { 'application/json': { schema: resolver(schema) } } } },
        },
        security,
      )
    : responseDoc(summary, schema, status, security);
function queryClient(q: { lang?: string }) {
  if (q.lang !== 'sql') return clickhouse;
  if (!queryClickhouse) throw new ApiError(503, 'sql_mode_unavailable', 'Configure the restricted ClickHouse query user to enable SQL mode.');
  return queryClickhouse;
}
const query = <T extends z.ZodType>(schema: T) =>
  validator('query', schema, (r, c) => {
    const text = c.req.query('q') ?? '';
    if (Buffer.byteLength(text) > 4096)
      throw new ch.QueryError('Query exceeds 4096 bytes', {
        lang: c.req.query('lang') === 'sql' ? 'sql' : 'query',
        reason: 'too_complex',
        start: 0,
        end: text.length,
        hint: 'Shorten the query to 4096 UTF-8 bytes',
      });
    if (!r.success) throw new ApiError(422, 'validation_error', 'Invalid query.', r.error);
  });
const found = <T>(value: T | null) => {
  if (value === null) throw new ApiError(404, 'not_found', 'Record not found.');
  return value;
};
const projectRead = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method !== 'GET' || /\/projects\/[^/]+\/export$/.test(c.req.path)) return next();
  await requireProjectReadable(c.get('project').id);
  await next();
});
const publicQueryLanguage = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.query('lang') === 'sql')
    throw new ApiError(
      422,
      'invalid_query',
      'SQL mode is available only in the console.',
      s.queryErrorDetailsSchema.parse({ lang: 'sql', reason: 'not_allowed', start: null, end: null, hint: 'Use lang=query with the read-key API' }),
    );
  await next();
});
export const publicRoutes = new Hono<AppEnv>()
  .post(
    '/events',
    requireApiKey('ingest'),
    publicRateLimits.authenticated('ingest'),
    publicQueryLanguage,
    doc('Ingest events', s.ingestResponseSchema, 202, 'ingestKey'),
    async (c) =>
      c.json(await ingest(c.get('project').id, await readIngestBody(c.req.raw), c.req.header('x-logbird-sdk') ?? c.req.header('user-agent')), 202),
  )
  .get(
    '/events',
    requireApiKey('read'),
    publicRateLimits.authenticated('read'),
    publicQueryLanguage,
    projectRead,
    doc('Search events', s.searchResponseSchema, 200, 'readKey'),
    query(s.publicSearchQuerySchema),
    async (c) =>
      c.json(s.searchResponseSchema.parse(await ch.searchEvents(queryClient(c.req.valid('query')), c.get('project').id, c.req.valid('query')))),
  )
  .get(
    '/events/:eventId',
    requireApiKey('read'),
    publicRateLimits.authenticated('read'),
    publicQueryLanguage,
    projectRead,
    doc('Event detail', s.eventDetailSchema, 200, 'readKey'),
    async (c) => c.json(s.eventDetailSchema.parse(found(await ch.getEvent(clickhouse, c.get('project').id, c.req.param('eventId'))))),
  );
async function activeWorkspace(c: Context<AppEnv>) {
  const id = c.get('activeOrganizationId');
  if (!id || !(await prisma.member.findFirst({ where: { organizationId: id, userId: c.get('user').id } })))
    throw new ApiError(403, 'organization_required', 'Select a workspace.');
  return id;
}
export const dataRoutes = new Hono<AppEnv>()
  .use('*', requireSession)
  .get('/workspace/activity', doc('Workspace activity', s.searchResponseSchema), query(s.searchQuerySchema), async (c) => {
    const id = await activeWorkspace(c);
    return c.json(s.searchResponseSchema.parse(await ch.searchEvents(queryClient(c.req.valid('query')), `ws:${id}`, c.req.valid('query'))));
  })
  .get('/workspace/exports/:exportId', doc('Export outcome', s.exportStatusSchema), async (c) => {
    const workspace = await activeWorkspace(c);
    const id = z.uuid().safeParse(c.req.param('exportId'));
    if (!id.success) throw new ApiError(404, 'not_found', 'Export record not found.');
    return c.json(s.exportStatusSchema.parse(await getExportStatus(id.data, `ws:${workspace}`)));
  })
  .use('/projects/:projectId/*', requireProjectAccess)
  .use('/projects/:projectId/*', projectRead)
  .get('/projects/:projectId/events', doc('Search events', s.searchResponseSchema), query(s.searchQuerySchema), async (c) =>
    c.json(s.searchResponseSchema.parse(await ch.searchEvents(queryClient(c.req.valid('query')), c.get('project').id, c.req.valid('query')))),
  )
  .get('/projects/:projectId/events/:eventId', doc('Event detail', s.eventDetailSchema), async (c) =>
    c.json(s.eventDetailSchema.parse(found(await ch.getEvent(clickhouse, c.get('project').id, c.req.param('eventId'))))),
  )
  .get(
    '/projects/:projectId/live',
    doc('Live events', z.array(s.eventSchema)),
    query(s.rangeQuerySchema.extend({ since: z.iso.datetime(), limit: z.coerce.number().int().min(1).max(200).default(50) })),
    async (c) =>
      c.json(z.array(s.eventSchema).parse(await ch.liveEvents(queryClient(c.req.valid('query')), c.get('project').id, c.req.valid('query')))),
  )
  .get('/projects/:projectId/histogram', doc('Histogram', s.histogramResponseSchema), query(s.histogramQuerySchema), async (c) =>
    c.json(s.histogramResponseSchema.parse(await ch.histogram(queryClient(c.req.valid('query')), c.get('project').id, c.req.valid('query')))),
  )
  .get('/projects/:projectId/facets', doc('Facets', s.facetResponseSchema), query(s.facetQuerySchema), async (c) =>
    c.json(s.facetResponseSchema.parse(await ch.facets(queryClient(c.req.valid('query')), c.get('project').id, c.req.valid('query')))),
  )
  .get('/projects/:projectId/overview', doc('Overview', s.overviewResponseSchema), query(s.rangeQuerySchema), async (c) =>
    c.json(s.overviewResponseSchema.parse(await ch.overview(queryClient(c.req.valid('query')), c.get('project').id, c.req.valid('query')))),
  )
  .get('/projects/:projectId/entities', doc('Entities', s.entityListResponseSchema), query(s.entityListQuerySchema), async (c) =>
    c.json(s.entityListResponseSchema.parse(await ch.listEntities(clickhouse, c.get('project').id, c.req.valid('query')))),
  )
  .get('/projects/:projectId/entities/:kind/:entityId', doc('Entity profile', s.entityProfileSchema), query(s.rangeQuerySchema), async (c) => {
    const kind = s.entityKindSchema.safeParse(c.req.param('kind'));
    if (!kind.success) throw new ApiError(422, 'validation_error', 'Invalid entity kind.');
    return c.json(
      s.entityProfileSchema.parse(
        found(
          await ch.entityProfile(queryClient(c.req.valid('query')), c.get('project').id, kind.data, c.req.param('entityId'), c.req.valid('query')),
        ),
      ),
    );
  })
  .get('/projects/:projectId/suggest', doc('Suggest field values', s.suggestResponseSchema), query(s.suggestQuerySchema), async (c) =>
    c.json(s.suggestResponseSchema.parse(await ch.suggestValues(queryClient(c.req.valid('query')), c.get('project').id, c.req.valid('query')))),
  )
  .get('/projects/:projectId/fields', doc('Fields', s.fieldsResponseSchema), query(s.rangeQuerySchema), async (c) =>
    c.json(s.fieldsResponseSchema.parse(await ch.listFields(queryClient(c.req.valid('query')), c.get('project').id, c.req.valid('query')))),
  )
  .get('/projects/:projectId/operations/:operationId', doc('Operation', z.array(s.eventSchema)), async (c) =>
    c.json(z.array(s.eventSchema).parse(await ch.operationEvents(clickhouse, c.get('project').id, c.req.param('operationId')))),
  )
  .post('/projects/:projectId/test-event', doc('Send test event', s.ingestResponseSchema, 202), async (c) =>
    c.json(
      await ingest(c.get('project').id, {
        action: 'sample.record.updated',
        actor: { ...c.get('user'), type: 'user' },
        executor: { type: 'api', id: 'api-server' },
        targets: [{ type: 'record', id: 'sample', name: 'Sample record' }],
        changes: [{ field: 'status', before: 'pending', after: 'approved' }],
        context: { requestId: c.get('requestId'), operationId: c.get('requestId') },
        description: 'Updated a sample record',
        occurredAt: new Date().toISOString(),
      }),
      202,
    ),
  )
  .get(
    '/projects/:projectId/export',
    routeDoc('Stream CSV or JSONL', {
      responses: {
        429: { description: 'Export capacity is in use. Finish or cancel an export, then retry.' },
        200: {
          description:
            'Versioned CSV/JSONL or complete original-payload JSONL, linked to workspace receipts by export id and SHA-256. See docs/exports.md.',
          headers: {
            [s.EXPORT_ID_HEADER]: { description: 'Stable export id in filename and workspace records.', schema: { type: 'string', format: 'uuid' } },
            [s.EXPORT_SCHEMA_HEADER]: {
              description: 'Export format and schema version.',
              schema: { type: 'string' },
            },
          },
          content: { 'text/csv': { schema: { type: 'string' } }, 'application/x-ndjson': { schema: { type: 'string' } } },
        },
      },
    }),
    query(s.exportQuerySchema),
    async (c) => {
      const input = c.req.valid('query');
      const clock = Date.now();
      const project = c.get('project');
      const exportId = randomUUID();
      const stream = `ws:${project.organizationId}`;
      let resolved: ch.ExportPlan | undefined;
      let membership: string | null = null;
      let stopHeartbeat: (() => void) | undefined;
      const expired = new AbortController();
      const formatName = s.EXPORT_FORMAT_LABELS[input.format];
      c.header(s.EXPORT_ID_HEADER, exportId);
      c.header(s.EXPORT_SCHEMA_HEADER, `${input.format}/${s.EXPORT_SCHEMA_VERSION}`);
      const body = await auditedExport(
        async (signal) => {
          const client = queryClient(input);
          resolved = await ch.prepareExport(client, input, clock);
          return ch.exportEvents(client, project.id, input, resolved, { signal, cancelQuery: cancelExportQuery });
        },
        input.format === 'csv',
        async (action, counts) => {
          const noun = counts.rows === 1 ? 'event' : 'events';
          const reasons = {
            client_aborted: 'download canceled',
            invalid_query: 'invalid query',
            audit_unavailable: 'audit record not confirmed',
            sql_unavailable: 'SQL mode unavailable',
            membership_changed: 'stored events changed; retry the export',
            project_unreadable: 'retention or deletion is incomplete; retry after maintenance',
            storage_unavailable: 'export validation storage unavailable; retry the export',
            project_busy: 'project busy; retry the export',
            idle_timeout: 'download inactive',
            lease_expired: 'export expired',
            resource_limit: 'query resource limit',
            export_error: 'export error',
          };
          const description =
            action === 'export.requested'
              ? `Started a ${formatName} export of ${project.name}`
              : action === 'export.completed'
                ? `Exported ${counts.rows} ${noun} from ${project.name} as ${formatName}`
                : `${reasons[counts.reason ?? 'export_error']} after ${counts.rows} ${noun}: ${formatName} export of ${project.name}`;
          const event: AuditPayload = {
            id: `${exportId}-${action.split('.')[1]}`,
            occurredAt: new Date().toISOString(),
            action,
            description: `Export ${exportId.slice(0, 8)}: ${description}`,
            outcome: action === 'export.failed' ? 'failure' : 'success',
            actor: { type: 'user', id: c.get('user').id, name: c.get('user').name || c.get('user').email },
            executor: { type: 'api', id: 'api-server' },
            targets: [
              { type: 'project', id: project.id, name: project.name },
              { type: 'export', id: exportId },
            ],
            context: {
              operationId: exportId,
              requestId: c.get('requestId'),
              ip: clientAddress(c) ?? '',
              userAgent: c.req.header('user-agent') ?? '',
            },
            metadata: {
              export: {
                exportId,
                projectId: project.id,
                format: input.format,
                formatLabel: formatName,
                schemaVersion: s.EXPORT_SCHEMA_VERSION,
                query: input.q?.trim() ?? '',
                lang: input.lang ?? 'query',
                clock: new Date(clock).toISOString(),
                receivedBefore: new Date(clock).toISOString(),
                from: resolved?.range.from ?? input.from?.slice(0, 128) ?? null,
                to: resolved?.range.to ?? input.to?.slice(0, 128) ?? null,
                resolvedQuery: resolved ? JSON.parse(JSON.stringify(resolved.compiled)) : null,
                ...counts,
              },
            },
          };
          if (action !== 'export.requested') return finishExport(exportId, stream, event);
          try {
            const unknown: AuditPayload = {
              ...event,
              id: `${exportId}-outcome`,
              action: 'export.outcome_unknown',
              outcome: 'unknown',
              description: `Export ${exportId.slice(0, 8)}: Outcome unknown for ${formatName} export of ${project.name} (producer outcome not confirmed)`,
              metadata: {
                export: {
                  ...(event.metadata as { export: Prisma.InputJsonObject }).export,
                  rows: null,
                  bytes: null,
                  reason: 'outcome_not_confirmed',
                },
              },
            };
            const stageStarted = performance.now();
            const requested = await stageExport({
              id: exportId,
              userId: c.get('user').id,
              workspaceId: project.organizationId,
              projectId: project.id,
              stream,
              requested: event,
              unknown,
              sql: input.lang === 'sql',
              receivedBefore: new Date(clock),
            });
            membership = requested.membership;
            if (membership)
              stopHeartbeat = startExportHeartbeat(
                () => renewExport(exportId),
                requested.leaseMs - (performance.now() - stageStarted),
                () => expired.abort(new ApiError(503, 'export_lease_expired', 'The export lease could not be renewed safely. Retry.')),
              );
            await deliverOutboxEvent(requested.id, ingest);
            if (!(await waitForAuditDelivery(requested.id))) throw new Error('Export request not acknowledged');
            if (!membership)
              throw new ApiError(
                503,
                'export_project_unreadable',
                'Retention or deletion is incomplete for this project. Retry after maintenance finishes.',
              );
          } catch (error) {
            if (error instanceof ApiError && ['export_busy', 'export_project_busy', 'export_project_unreadable'].includes(error.code)) throw error;
            throw new ApiError(503, 'export_audit_unavailable', 'The export request could not be recorded. Retry the export before downloading.');
          }
        },
        AbortSignal.any([c.req.raw.signal, expired.signal]),
        exportId,
        {
          beforeComplete: (signal) => validateExportMembership(project.id, membership, exportId, signal),
          onTerminal: (action) => confirmExportOutcome(exportId, action),
          onSettled: async () => {
            stopHeartbeat?.();
            await releaseExportAdmission(exportId);
          },
        },
      );
      c.header('Content-Type', input.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson');
      c.header(
        'Content-Disposition',
        `attachment; filename="events-${exportId}${input.format === 'jsonl-evidence' ? '-evidence' : ''}.${input.format === 'csv' ? 'csv' : 'jsonl'}"`,
      );
      return c.body(body);
    },
  );
