import * as ch from '@trailmark/clickhouse';
import * as s from '@trailmark/contracts';
import { prisma, withProjectLock } from '@trailmark/database';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { stream } from 'hono/streaming';
import { describeRoute, resolver, validator } from 'hono-openapi';
import { z } from 'zod';
import { clickhouse } from './clickhouse';
import { ApiError } from './errors';
import { ingest, readIngestBody, requireRetentionReady } from './ingest';
import { requireApiKey, requireProjectAccess, requireSession } from './middlewares';
import type { AppEnv } from './types';

const doc = (summary: string, schema: z.ZodType, status = 200, security = 'session') =>
  describeRoute({
    summary,
    security: [{ [security]: [] }],
    ...(summary === 'Ingest events'
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object' as const,
                  description: 'Single event or {events: [...]}. Gzip supported. Maximum 1000 events, 5 MiB decoded body and 256 KiB per event.',
                },
              },
            },
          },
        }
      : {}),
    responses: {
      [status]: { description: summary, content: { 'application/json': { schema: resolver(schema) } } },
      ...Object.fromEntries(
        [400, 401, 404, 413, 422, 503].map((code) => [
          code,
          { description: 'Request error', content: { 'application/json': { schema: resolver(s.apiErrorSchema) } } },
        ]),
      ),
    },
  });
const query = <T extends z.ZodType>(schema: T) =>
  validator('query', schema, (r) => {
    if (!r.success) throw new ApiError(422, 'validation_error', 'Invalid query.', r.error);
  });
const found = <T>(value: T | null) => {
  if (value === null) throw new ApiError(404, 'not_found', 'Record not found.');
  return value;
};
const projectRead = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method !== 'GET' || c.req.path.endsWith('/export')) return next();
  await withProjectLock(c.get('project').id, async (tx) => {
    await requireRetentionReady(tx, c.get('project').id);
    await next();
  });
});
export const publicRoutes = new Hono<AppEnv>()
  .post('/events', requireApiKey('ingest'), doc('Ingest events', s.ingestResponseSchema, 202, 'ingestKey'), async (c) =>
    c.json(await ingest(c.get('project').id, await readIngestBody(c.req.raw), c.req.header('x-trailmark-sdk') ?? c.req.header('user-agent')), 202),
  )
  .get(
    '/events',
    requireApiKey('read'),
    projectRead,
    doc('Search events', s.searchResponseSchema, 200, 'readKey'),
    query(s.searchQuerySchema),
    async (c) => c.json(s.searchResponseSchema.parse(await ch.searchEvents(clickhouse, c.get('project').id, c.req.valid('query')))),
  )
  .get('/events/:eventId', requireApiKey('read'), projectRead, doc('Event detail', s.eventDetailSchema, 200, 'readKey'), async (c) =>
    c.json(s.eventDetailSchema.parse(found(await ch.getEvent(clickhouse, c.get('project').id, c.req.param('eventId'))))),
  );
export const dataRoutes = new Hono<AppEnv>()
  .use('*', requireSession)
  .get('/workspace/activity', doc('Workspace activity', s.searchResponseSchema), query(s.searchQuerySchema), async (c) => {
    const id = c.get('activeOrganizationId');
    if (!id || !(await prisma.member.findFirst({ where: { organizationId: id, userId: c.get('user').id } })))
      throw new ApiError(403, 'organization_required', 'Select a workspace.');
    return c.json(s.searchResponseSchema.parse(await ch.searchEvents(clickhouse, `ws:${id}`, c.req.valid('query'))));
  })
  .use('/projects/:projectId/*', requireProjectAccess)
  .use('/projects/:projectId/*', projectRead)
  .get('/projects/:projectId/events', doc('Search events', s.searchResponseSchema), query(s.searchQuerySchema), async (c) =>
    c.json(s.searchResponseSchema.parse(await ch.searchEvents(clickhouse, c.get('project').id, c.req.valid('query')))),
  )
  .get('/projects/:projectId/events/:eventId', doc('Event detail', s.eventDetailSchema), async (c) =>
    c.json(s.eventDetailSchema.parse(found(await ch.getEvent(clickhouse, c.get('project').id, c.req.param('eventId'))))),
  )
  .get(
    '/projects/:projectId/live',
    doc('Live events', z.array(s.eventSchema)),
    query(s.rangeQuerySchema.extend({ since: z.iso.datetime(), limit: z.coerce.number().int().min(1).max(200).default(50) })),
    async (c) => c.json(z.array(s.eventSchema).parse(await ch.liveEvents(clickhouse, c.get('project').id, c.req.valid('query')))),
  )
  .get('/projects/:projectId/histogram', doc('Histogram', s.histogramResponseSchema), query(s.histogramQuerySchema), async (c) =>
    c.json(s.histogramResponseSchema.parse(await ch.histogram(clickhouse, c.get('project').id, c.req.valid('query')))),
  )
  .get('/projects/:projectId/facets', doc('Facets', s.facetResponseSchema), query(s.facetQuerySchema), async (c) =>
    c.json(s.facetResponseSchema.parse(await ch.facets(clickhouse, c.get('project').id, c.req.valid('query')))),
  )
  .get('/projects/:projectId/overview', doc('Overview', s.overviewResponseSchema), query(s.rangeQuerySchema), async (c) =>
    c.json(s.overviewResponseSchema.parse(await ch.overview(clickhouse, c.get('project').id, c.req.valid('query')))),
  )
  .get('/projects/:projectId/entities', doc('Entities', s.entityListResponseSchema), query(s.entityListQuerySchema), async (c) =>
    c.json(s.entityListResponseSchema.parse(await ch.listEntities(clickhouse, c.get('project').id, c.req.valid('query')))),
  )
  .get('/projects/:projectId/entities/:kind/:entityId', doc('Entity profile', s.entityProfileSchema), query(s.rangeQuerySchema), async (c) => {
    const kind = s.entityKindSchema.safeParse(c.req.param('kind'));
    if (!kind.success) throw new ApiError(422, 'validation_error', 'Invalid entity kind.');
    return c.json(
      s.entityProfileSchema.parse(
        found(await ch.entityProfile(clickhouse, c.get('project').id, kind.data, c.req.param('entityId'), c.req.valid('query'))),
      ),
    );
  })
  .get('/projects/:projectId/fields', doc('Fields', s.fieldsResponseSchema), query(s.rangeQuerySchema), async (c) =>
    c.json(s.fieldsResponseSchema.parse(await ch.listFields(clickhouse, c.get('project').id, c.req.valid('query')))),
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
    describeRoute({ summary: 'Stream CSV or JSONL', responses: { 200: { description: 'Event export' } } }),
    query(s.rangeQuerySchema.extend({ format: z.enum(['csv', 'jsonl']) })),
    async (c) => {
      const q = c.req.valid('query');
      let markReady!: () => void, failReady!: (error: unknown) => void, finish!: () => void;
      const ready = new Promise<void>((resolve, reject) => {
        markReady = resolve;
        failReady = reject;
      });
      const release = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let iterator: ReturnType<typeof ch.exportEvents>;
      let first: IteratorResult<string>;
      // Keep the same cross-process lock until the HTTP stream closes.
      const task = withProjectLock(c.get('project').id, async (tx) => {
        await requireRetentionReady(tx, c.get('project').id);
        iterator = ch.exportEvents(clickhouse, c.get('project').id, q);
        try {
          first = await iterator.next();
          markReady();
          await release;
        } finally {
          await iterator.return();
        }
      });
      void task.catch((error) => failReady(error));
      await ready;
      c.header('Content-Type', q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson');
      c.header('Content-Disposition', `attachment; filename="events.${q.format}"`);
      return stream(c, async (out) => {
        try {
          if (!first.done) await out.write(first.value);
          for await (const chunk of iterator) await out.write(chunk);
        } finally {
          finish();
          await task;
        }
      });
    },
  );
