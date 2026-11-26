import { randomUUID } from 'node:crypto';
import * as ch from '@logbird/clickhouse';
import * as s from '@logbird/contracts';
import { type AuditPayload, type Prisma, prisma } from '@logbird/database';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { type DescribeRouteOptions, resolver, validator } from 'hono-openapi';
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
import { requireApiKey, requireProjectAccess, requireReader, requireSession } from './middlewares';
import { doc as responseDoc, routeDoc } from './openapi';
import { deliverOutboxEvent, waitForAuditDelivery } from './outbox-delivery';
import { beginRollupRead, finishRollupRead } from './project-read';
import { clientAddress, publicRateLimits } from './rate-limit';
import { assertNotMasked, fieldMaskSecret, forbidMaskedEvidence, maskEvent, mintViewerToken, scopeWithin } from './read-access';
import type { AppEnv } from './types';

const ingestRequestSchema = (await resolver(s.ingestBodySchema).toOpenAPISchema()).schema;
const viewerTokenRequestSchema = (await resolver(s.viewerTokenRequestSchema).toOpenAPISchema()).schema;
const CSV_COLUMNS_TEXT = ch.CSV_COLUMNS.join(', ');
const rangeHeaders = {
  [s.RANGE_FROM_HEADER]: {
    description:
      "Inclusive start of the time window applied (ISO 8601 UTC, milliseconds): the request's `from`, or `to` minus 24 hours, never before 1900-01-01T00:00:00.000Z.",
    schema: { type: 'string' as const, format: 'date-time' },
  },
  [s.RANGE_TO_HEADER]: {
    description:
      "Exclusive end of the time window applied (ISO 8601 UTC, milliseconds): the request's `to`, or the server clock, never after 2299-12-31T23:59:59.999Z.",
    schema: { type: 'string' as const, format: 'date-time' },
  },
};
const exportResponses = {
  429: { description: 'Export capacity is in use. Finish or cancel an export, then retry.' },
  200: {
    description: `Versioned CSV/JSONL or complete original-payload JSONL (jsonl-evidence; 422 masked_export for masked scopes), limited to the caller scope. Normalized changes include beforeKind and afterKind when known, including in the JSON-encoded CSV changes cell. CSV columns: ${CSV_COLUMNS_TEXT}. There is no trailer: a complete download is one that ends normally (a non-empty file ends with a newline; an export with no matching events is an empty JSONL body or a CSV header only); a failure after the headers aborts the connection, so treat any transport error as an incomplete file and discard it. Audited in workspace activity as export.requested, then export.completed or export.failed (actor = the API key; metadata.access names the key, tenant and viewer token). See docs/exports.md.`,
    headers: {
      [s.EXPORT_ID_HEADER]: {
        description: 'Stable export id in filename and workspace records.',
        schema: { type: 'string' as const, format: 'uuid' },
      },
      [s.EXPORT_SCHEMA_HEADER]: { description: 'Export format and schema version.', schema: { type: 'string' as const } },
      ...rangeHeaders,
    },
    content: { 'text/csv': { schema: { type: 'string' as const } }, 'application/x-ndjson': { schema: { type: 'string' as const } } },
  },
};
/** What each /v1 read route does, and which time window it reads (OpenAPI `description`). */
const READ_ROUTE_TEXT = {
  search:
    "Search stored events in one time window, one page at a time. The window runs from `from` (inclusive) to `to` (exclusive) on the stored `timestamp`: the event's occurredAt, or the time Logbird received it when occurredAt was absent or unusable. Without `from` it is at most the 24 hours before `to` (the store limits, 1900-01-01T00:00:00.000Z to 2299-12-31T23:59:59.999Z, can shorten it); without `to` it ends at the server clock. The response states the window it applied as `range`: a history read here is complete only for that window, whatever `totalExact` says. Events sort by `timestamp`, then by event `id` in the same direction (`order`). Events in the same millisecond are ordered by id, not by cause: read causation from `context.parentEventId`. Follow `nextCursor` until it is null, sending the same `q` and `order`, and the first page's `range` as `from` and `to` (a cursor carries no window, so omitted bounds would be resolved again on every page), and use absolute times in `q`: a relative time (`receivedAt:>now-1h`) is read against each request's clock and can drop an event between pages. Each page continues after the previous page's last event. Fixed bounds keep the window, not the events: the pass is still not a snapshot. Paging is not a snapshot: an event stored after you started, with a `timestamp` behind your position, is not on the later pages. `receivedAt:` in `q` helps find late arrivals, with a `from` early enough to cover when they can have occurred (the window still filters on `timestamp`). Receipt times are not a strict sequence: events can share a millisecond, and an event recovered after a storage failure keeps its original receipt time. So re-read with a generous overlap (`receivedAt:>=` a time well before the last one you saw) and drop ids you already have; an overlap narrows the gap but cannot prove it closed. `total` counts the whole window (a lower bound when `totalExact` is false). A scoped key or viewer token sees only its scope, and `q` cannot widen it. To rebuild a record's whole history step by step, follow the reading guide: https://github.com/joodlab/logbird/blob/master/docs/reading-history.md",
  detail:
    "One event by id. No time window applies. Returns the event; its original `payload` (null under any field mask); `parents`, its nearest ancestors through `context.parentEventId`, furthest first, at most 100. The walk also stops at a parent that is not stored or is outside the reader's scope, at a cycle, and under the actor_email mask at a parent with tying stored versions, so the first entry is not necessarily the root. `childCount` is the number of events in scope that name it as their parent, across all stored history: to list them, search `parent:<id>` (quote the id by the query language rules in docs/query-language.md, so a `*` in it is not a wildcard) with `from` and `to` that cover them: a child can be dated up to 24 hours in the future. `operationSize` is the number of events in scope that share its `context.operationId`, itself included, across all stored history (0 without one). 404 not_found when the id is unknown or outside the reader's scope, or, under the actor_email mask, when its own stored versions tie the same way.",
  facets:
    'Counts of the most frequent values of `field` (optionally split `by` a second field) among the events in one time window that match `q`. Same window rules as search: without `from` it is at most the 24 hours before `to` (the store limits, 1900-01-01T00:00:00.000Z to 2299-12-31T23:59:59.999Z, can shorten it), and the response states the window it applied as `range`. Values are ordered by count, most frequent first.',
  project:
    "How far back this caller's history reaches. `oldestEventAt` is the `timestamp` of the oldest event this caller can find through search: the first event that an `order=asc` search over the widest window (`from` 1900-01-01T00:00:00.000Z, `to` 2299-12-31T23:59:59.999Z, exclusive) returns to the same caller, within its scope for a scoped key or viewer token, or null when that search finds none. It describes what is stored now, not what ever existed: an empty history before it does not prove that nothing happened then. `retentionDays` is the project's retention policy, the same for every reader of the project, and the one value here that a scoped caller could not already find. Each retention run (hourly, and right after the window is shortened) deletes for good the events dated more than that many days before the run. Between runs, older events can still be stored and found, for example one that arrived dated in the past, so `oldestEventAt` can lie before now minus `retentionDays`, and it can move back as well as forward. Raising `retentionDays` restores nothing. To read a whole history, search from `oldestEventAt` to a `to` later than any stored event: an event can be dated up to one day after it was received, so use a `to` more than a day after now (for example two days).",
  export:
    'Every event in one time window that matches `q`, streamed oldest first (`timestamp`, then event `id`), as CSV, JSONL or original-payload JSONL. Same window rules as search: without `from` the export covers at most the 24 hours before `to` (the store limits, 1900-01-01T00:00:00.000Z to 2299-12-31T23:59:59.999Z, can shorten it). An answer that streams rows carries the X-Logbird-Range-From (inclusive) and X-Logbird-Range-To (exclusive) headers: the window applied. Membership is fixed by the export clock: an event is in the file only if its stored receipt time is at or before the moment the export started (docs/exports.md states the exact guarantee).',
};
const readDoc = (summary: string, description: string, schema: z.ZodType, parameters?: DescribeRouteOptions['parameters']) =>
  routeDoc(
    summary,
    {
      description,
      ...(parameters ? { parameters } : {}),
      responses: { 200: { description: summary, content: { 'application/json': { schema: resolver(schema) } } } },
    },
    'readKeyOrViewerToken',
  );

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
          parameters: [
            {
              name: s.LOGBIRD_RETRY_HEADER,
              in: 'header',
              required: false,
              description:
                'Send `subset` if the client resends only unsettled events: events left unchecked after parse failures then come back as retryable 503 ingest_pending instead of terminal unverified_after_parse_failure rejections.',
              schema: { type: 'string', enum: [s.LOGBIRD_RETRY_SUBSET] },
            },
          ],
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
/**
 * Scoped reads (#138) go through the restricted query user when it is configured, whose row policy binds the project
 * and the tenant (phase 2: a second, database-enforced layer under the query builders' scope predicate). Unscoped
 * reads, and installations without the query user, use the main client as before.
 */
const readerClient = (scope: s.ReadScope | null) => (scope && queryClickhouse ? ch.withTenant(queryClickhouse, scope.tenantId) : clickhouse);
const query = <T extends z.ZodType>(schema: T) =>
  validator('query', schema, (r, c) => {
    const text = c.req.query('q') ?? '';
    if (Buffer.byteLength(text) > s.REQUEST_LIMITS.queryBytes)
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
function entityKind(value: string) {
  const kind = s.entityKindSchema.safeParse(value);
  if (!kind.success) throw new ApiError(422, 'validation_error', 'Invalid entity kind.');
  return kind.data;
}
const projectRead = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method !== 'GET' || /(?:\/projects\/[^/]+|^\/v1)\/export$/.test(c.req.path)) return next();
  const projectId = c.get('project').id;
  // These non-streaming responses use derived destinations (fields is guarded for compatibility).
  const rollup = /^\/api\/projects\/[^/]+\/(?:entities(?:\/.*)?|overview|fields|suggest)$/.test(c.req.path);
  if (!rollup) {
    await requireProjectReadable(projectId);
    return next();
  }
  const generation = await beginRollupRead(projectId);
  await next();
  // Hono has materialized even an error response here: a concurrent repair must override false 404s too.
  await finishRollupRead(projectId, generation);
});
/** Hono answers HEAD through GET handlers: exports refuse it before validation and admission (405, Allow: GET). */
const noHeadExport = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method === 'HEAD') {
    c.header('Allow', 'GET');
    return c.body(null, 405);
  }
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
      c.json(
        await ingest(
          c.get('project').id,
          await readIngestBody(c.req.raw),
          c.req.header('x-logbird-sdk') ?? c.req.header('user-agent'),
          c.req.header(s.LOGBIRD_RETRY_HEADER) === s.LOGBIRD_RETRY_SUBSET,
        ),
        202,
      ),
  )
  .get(
    '/events',
    requireReader(),
    publicRateLimits.authenticated('read'),
    publicQueryLanguage,
    projectRead,
    readDoc('Search events', READ_ROUTE_TEXT.search, s.searchResponseSchema),
    query(s.publicSearchQuerySchema),
    async (c) => {
      const input = c.req.valid('query');
      const { scope } = c.get('reader');
      assertNotMasked(scope, input);
      const page = await ch.searchEvents(readerClient(scope), c.get('project').id, input, undefined, scope);
      return c.json(s.searchResponseSchema.parse({ ...page, data: page.data.map((e) => maskEvent(e, scope?.mask)) }));
    },
  )
  .get(
    '/events/:eventId',
    requireReader(),
    publicRateLimits.authenticated('read'),
    publicQueryLanguage,
    projectRead,
    readDoc('Event detail', READ_ROUTE_TEXT.detail, s.eventDetailSchema, [
      { name: 'eventId', in: 'path', required: true, description: 'The event `id`.', schema: { type: 'string' } },
    ]),
    async (c) => {
      const { scope } = c.get('reader');
      const detail = found(await ch.getEvent(readerClient(scope), c.get('project').id, c.req.param('eventId'), scope, clickhouse));
      const mask = scope?.mask;
      return c.json(
        s.eventDetailSchema.parse(
          mask?.length
            ? // Any mask also drops the original document: it would carry the masked values.
              { ...detail, event: maskEvent(detail.event, mask), parents: detail.parents.map((e) => maskEvent(e, mask)), payload: null }
            : detail,
        ),
      );
    },
  )
  .get(
    '/facets',
    requireReader(),
    publicRateLimits.authenticated('read'),
    publicQueryLanguage,
    projectRead,
    readDoc('Facets', READ_ROUTE_TEXT.facets, s.facetResponseSchema),
    query(s.publicFacetQuerySchema),
    async (c) => {
      const input = c.req.valid('query');
      const { scope } = c.get('reader');
      assertNotMasked(scope, input);
      // The mask key lets facets show a name that is the address as the same pseudonym the scope's events carry (#333).
      const key = scope?.mask?.length ? fieldMaskSecret() : undefined;
      return c.json(s.facetResponseSchema.parse(await ch.facets(readerClient(scope), c.get('project').id, input, scope, undefined, key)));
    },
  )
  .get(
    '/project',
    // Hono answers HEAD through this GET handler, and the maintenance fence (projectRead) checks GET only: refuse HEAD.
    noHeadExport,
    requireReader(),
    publicRateLimits.authenticated('read'),
    publicQueryLanguage,
    projectRead,
    readDoc('History horizon', READ_ROUTE_TEXT.project, s.historyHorizonSchema),
    async (c) => {
      const project = c.get('project');
      const { scope } = c.get('reader');
      // The policy is read fresh: viewer-token authentication caches the key's project for up to 30 seconds.
      const [policy, oldestEventAt] = await Promise.all([
        prisma.project.findUnique({ where: { id: project.id }, select: { retentionDays: true } }),
        ch.oldestVisibleEvent(readerClient(scope), project.id, scope),
      ]);
      return c.json(s.historyHorizonSchema.parse({ retentionDays: found(policy).retentionDays, oldestEventAt }));
    },
  )
  .get(
    '/export',
    noHeadExport,
    requireReader(),
    publicRateLimits.authenticated('read'),
    publicQueryLanguage,
    projectRead,
    routeDoc('Stream CSV or JSONL', { description: READ_ROUTE_TEXT.export, responses: exportResponses }, 'readKeyOrViewerToken'),
    query(s.publicExportQuerySchema),
    async (c) => {
      const input = c.req.valid('query');
      const reader = c.get('reader');
      // Refusals before admission leave no export record, like the console's admission refusals.
      forbidMaskedEvidence(reader.scope, input.format);
      assertNotMasked(reader.scope, input);
      return runExport(c, input, {
        actor: { type: 'api_key', id: reader.keyId, name: reader.keyName },
        leaseUser: `api_key:${reader.keyId}`,
        client: readerClient(reader.scope),
        scope: reader.scope,
        map: reader.scope?.mask?.length ? (e) => maskEvent(e, reader.scope?.mask) : undefined,
        access: {
          via: reader.via === 'token' ? 'viewer_token' : 'api_key',
          apiKeyId: reader.keyId,
          viaToken: reader.via === 'token',
          tenantId: reader.scope?.tenantId ?? null,
          jti: reader.jti ?? null,
          scope: reader.scope,
        },
      });
    },
  )
  .post(
    '/viewer-tokens',
    requireReader({ tokens: false }),
    publicRateLimits.mint(),
    // A valid scope is a few KB at most: refuse larger bodies before buffering them for JSON parsing.
    bodyLimit({
      maxSize: s.REQUEST_LIMITS.viewerTokenBodyBytes,
      onError: (c) => c.json({ error: { code: 'payload_too_large', message: 'Request exceeds 16 KB.' } }, 413),
    }),
    routeDoc(
      'Mint viewer token',
      {
        requestBody: {
          required: true,
          description: 'Scope equal to or narrower than the key scope; ttlSeconds 60–3600 (default 900).',
          content: {
            'application/json': {
              schema: viewerTokenRequestSchema,
              example: { scope: { tenantId: 'biz_5', target: { type: 'website', id: 'site_42' } }, ttlSeconds: 900 },
            },
          },
        },
        responses: {
          201: { description: 'Viewer token', content: { 'application/json': { schema: resolver(s.viewerTokenResponseSchema) } } },
          403: {
            description:
              'scope_exceeded: the requested scope is wider than the key scope. forbidden: the credential is a viewer token, which can never mint (use a read key).',
            content: { 'application/json': { schema: resolver(s.apiErrorSchema) } },
          },
        },
      },
      'readKey',
    ),
    validator('json', s.viewerTokenRequestSchema, (r) => {
      if (!r.success) throw new ApiError(422, 'validation_error', 'Invalid request body.', r.error);
    }),
    async (c) => {
      const input = c.req.valid('json');
      const reader = c.get('reader');
      if (!scopeWithin(input.scope, reader.scope)) throw new ApiError(403, 'scope_exceeded', 'The requested scope is wider than the key scope.');
      const minted = mintViewerToken({ keyId: reader.keyId, projectId: c.get('project').id, scope: input.scope, ttlSeconds: input.ttlSeconds });
      c.header('Cache-Control', 'no-store');
      return c.json(s.viewerTokenResponseSchema.parse({ token: minted.token, expiresAt: minted.expiresAt, scope: input.scope }), 201);
    },
  );
/** Who runs an export: a console user, or a read key / viewer token (#138), and the scope applied to every row. */
type ExportCaller = {
  /** The ClickHouse client for the rows (scoped exports use the restricted query user when configured). */
  client?: ch.ClickHouseClient;
  actor: { type: string; id: string; name: string };
  /** Admission identity: one running export per user, or per API key. */
  leaseUser: string;
  scope: s.ReadScope | null;
  map?: (event: s.AuditEvent) => s.AuditEvent;
  /** API exports: recorded in the audit metadata (`access`). */
  access?: {
    via: 'api_key' | 'viewer_token';
    apiKeyId: string;
    viaToken: boolean;
    tenantId: string | null;
    jti: string | null;
    scope: s.ReadScope | null;
  };
};
async function runExport(c: Context<AppEnv>, input: s.ExportQuery, caller: ExportCaller) {
  // Hono answers HEAD through GET handlers and drops the body: refuse it before admission, so a HEAD can neither take the
  // caller's export slot nor record export.requested.
  if (c.req.method === 'HEAD') {
    c.header('Allow', 'GET');
    return c.body(null, 405);
  }
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
      const client = caller.client ?? queryClient(input);
      resolved = await ch.prepareExport(client, input, clock);
      return ch.exportEvents(
        client,
        project.id,
        input,
        resolved,
        { signal, cancelQuery: cancelExportQuery, tag: exportId },
        { scope: caller.scope, map: caller.map },
      );
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
        project_unreadable: 'data maintenance is incomplete; retry after maintenance',
        storage_unavailable: 'export validation storage unavailable; retry the export',
        project_busy: 'project busy; retry the export',
        idle_timeout: 'download inactive',
        lease_expired: 'export expired',
        resource_limit: 'query resource limit',
        export_error: 'export error',
      };
      const via = caller.access ? ` via ${caller.access.viaToken ? 'a viewer token of' : 'API key'} “${caller.actor.name}”` : '';
      const description =
        action === 'export.requested'
          ? `Started a ${formatName} export of ${project.name}`
          : action === 'export.completed'
            ? `Exported ${counts.rows} ${noun} from ${project.name} as ${formatName}`
            : `${counts.reason === 'client_aborted' ? 'Canceled' : 'Failed'} after ${counts.rows} ${noun}: ${reasons[counts.reason ?? 'export_error']}. ${formatName} export of ${project.name}`;
      const describedWith = `${description}${via}`;
      const event: AuditPayload = {
        id: `${exportId}-${action.split('.')[1]}`,
        occurredAt: new Date().toISOString(),
        action,
        description: `Export ${exportId.slice(0, 8)}: ${describedWith}`,
        outcome: action === 'export.failed' ? 'failure' : 'success',
        actor: caller.actor,
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
          ...(caller.access ? { access: caller.access } : {}),
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
            ...(event.metadata as Prisma.InputJsonObject),
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
          userId: caller.leaseUser,
          workspaceId: project.organizationId,
          projectId: project.id,
          stream,
          requested: event,
          unknown,
          // The restricted profile allows 1 GiB per query: SQL mode and scoped (restricted) exports take both slots.
          sql: input.lang === 'sql' || Boolean(caller.client && ch.isQueryClient(caller.client)),
          receivedBefore: new Date(clock),
          signal: c.req.raw.signal,
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
          throw new ApiError(503, 'export_project_unreadable', 'Data maintenance is incomplete for this project. Retry after maintenance finishes.');
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
  // The stream has no envelope, so the window goes in headers. Only on the answer that streams rows: the export has
  // compiled its query and read its first page by now, so these are the bounds every page uses (a refusal states none).
  if (resolved) {
    c.header(s.RANGE_FROM_HEADER, resolved.range.from);
    c.header(s.RANGE_TO_HEADER, resolved.range.to);
  }
  c.header('Content-Type', input.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson');
  c.header(
    'Content-Disposition',
    `attachment; filename="events-${exportId}${input.format === 'jsonl-evidence' ? '-evidence' : ''}.${input.format === 'csv' ? 'csv' : 'jsonl'}"`,
  );
  return c.body(body);
}
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
  .get(
    '/projects/:projectId/entities/:kind/:entityId',
    doc('Entity profile', s.entityProfileSchema),
    query(s.entityProfileQuerySchema),
    async (c) => {
      const kind = entityKind(c.req.param('kind'));
      return c.json(
        s.entityProfileSchema.parse(
          found(await ch.entityProfile(queryClient(c.req.valid('query')), c.get('project').id, kind, c.req.param('entityId'), c.req.valid('query'))),
        ),
      );
    },
  )
  .get(
    '/projects/:projectId/entities/:kind/:entityId/metadata',
    doc('Entity display metadata', s.entityMetadataSchema),
    query(s.entityMetadataQuerySchema),
    async (c) =>
      c.json(
        s.entityMetadataSchema.parse(
          found(
            await ch.entityMetadata(
              clickhouse,
              c.get('project').id,
              entityKind(c.req.param('kind')),
              c.req.param('entityId'),
              c.req.valid('query').targetType,
            ),
          ),
        ),
      ),
  )
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
        // Only the envelope fields: a large profile field (image) could exceed 256 KB and leak into the stream.
        actor: { type: 'user', id: c.get('user').id, name: c.get('user').name, email: c.get('user').email },
        executor: { type: 'api', id: 'api-server' },
        targets: [{ type: 'record', id: 'sample', name: 'Sample record' }],
        changes: [{ field: 'status', before: 'pending', after: 'approved' }],
        context: { requestId: c.get('requestId'), operationId: c.get('requestId') },
        description: 'Updated a sample record',
        occurredAt: new Date().toISOString(),
        source: s.CONSOLE_TEST_EVENT_SOURCE,
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
            ...rangeHeaders,
          },
          content: { 'text/csv': { schema: { type: 'string' } }, 'application/x-ndjson': { schema: { type: 'string' } } },
        },
      },
    }),
    noHeadExport,
    query(s.exportQuerySchema),
    async (c) =>
      runExport(c, c.req.valid('query'), {
        actor: { type: 'user', id: c.get('user').id, name: c.get('user').name || c.get('user').email },
        leaseUser: c.get('user').id,
        scope: null,
      }),
  );
