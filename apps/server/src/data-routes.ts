import { randomUUID } from 'node:crypto';
import * as ch from '@logbird/clickhouse';
import * as s from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { resolver, validator } from 'hono-openapi';
import { z } from 'zod';
import { clickhouse, queryClickhouse } from './clickhouse';
import { ApiError } from './errors';
import { auditedExport } from './export-stream';
import { ingest, readIngestBody, requireProjectReadable } from './ingest';
import { requireApiKey, requireProjectAccess, requireSession } from './middlewares';
import { doc as responseDoc, routeDoc } from './openapi';
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
  if (c.req.method !== 'GET') return next();
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
export const dataRoutes = new Hono<AppEnv>()
  .use('*', requireSession)
  .get('/workspace/activity', doc('Workspace activity', s.searchResponseSchema), query(s.searchQuerySchema), async (c) => {
    const id = c.get('activeOrganizationId');
    if (!id || !(await prisma.member.findFirst({ where: { organizationId: id, userId: c.get('user').id } })))
      throw new ApiError(403, 'organization_required', 'Select a workspace.');
    return c.json(s.searchResponseSchema.parse(await ch.searchEvents(queryClient(c.req.valid('query')), `ws:${id}`, c.req.valid('query'))));
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
        200: {
          description: 'Normalized CSV/JSONL or original-payload evidence JSONL. See docs/exports.md for schemas and audit semantics.',
          content: { 'text/csv': { schema: { type: 'string' } }, 'application/x-ndjson': { schema: { type: 'string' } } },
        },
      },
    }),
    query(s.exportQuerySchema),
    async (c) => {
      const input = c.req.valid('query');
      const q = { ...input, ...ch.timeRange(input), q: input.q?.trim() ?? '', lang: input.lang ?? ('query' as const) };
      const client = queryClient(q);
      const project = c.get('project');
      const exportId = randomUUID();
      const body = await auditedExport(
        ch.exportEvents(client, project.id, q),
        q.format === 'csv',
        (action, counts) =>
          ingest(`ws:${project.organizationId}`, {
            action,
            outcome: action === 'export.failed' ? 'failure' : 'success',
            actor: { type: 'user', ...c.get('user') },
            executor: { type: 'api', id: 'api-server' },
            targets: [{ type: 'project', id: project.id, name: project.name }],
            context: {
              operationId: exportId,
              requestId: c.get('requestId'),
              ip: clientAddress(c) ?? '',
              userAgent: c.req.header('user-agent') ?? '',
            },
            metadata: { export: { exportId, projectId: project.id, format: q.format, query: q.q, lang: q.lang, from: q.from, to: q.to, ...counts } },
          }),
        c.req.raw.signal,
      );
      c.header('Content-Type', q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson');
      c.header(
        'Content-Disposition',
        `attachment; filename="events${q.format === 'jsonl-evidence' ? '-evidence' : ''}.${q.format === 'csv' ? 'csv' : 'jsonl'}"`,
      );
      return c.body(body);
    },
  );
