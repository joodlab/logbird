import { z } from 'zod';
import { eventSchema } from './events';
import { QUERY_FIELDS, queryLangSchema } from './query';
export const API_KEY_SCOPES = { read: 'events:read', ingest: 'events:ingest' } as const;
export const updateWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
  })
  .strict()
  .refine((input) => input.name !== undefined || input.slug !== undefined, 'Provide a name or slug.');
export const workspaceSchema = z.object({ id: z.string(), name: z.string(), slug: z.string() });

/* ------------------------------------------------------------------ */
/* Shared query params                                                 */
/* ------------------------------------------------------------------ */

/**
 * Every read endpoint accepts a time range and a query string.
 * `q` uses the Logbird query language (see docs/SPEC.md §5.1) unless `lang=sql`:
 *   action:hotel.*  outcome:failure  actor:usr_123  -env:staging  attempt:>2  metadata.channel:whatsapp  "free text"
 * With `lang=sql`, `q` is a ClickHouse WHERE expression (see ./query.ts). Invalid queries answer 422
 * `invalid_query` with `details: QueryErrorDetails`.
 */
/** Without `from`, a read covers this much time before `to` (24 hours). */
export const DEFAULT_RANGE_MS = 86_400_000;
export const rangeQuerySchema = z.object({
  from: z.string().optional(), // ISO; default to − 24h
  to: z.string().optional(), // ISO; default now
  q: z.string().max(4096).optional().meta({ example: 'action:document.updated' }),
  lang: queryLangSchema.optional(), // absent = 'query'
});
export type RangeQuery = z.infer<typeof rangeQuerySchema>;
/**
 * The time window a read applied, so a reader can tell a short history from a short window. Same form and same rule
 * as the request's `from` and `to`: `from` inclusive, `to` exclusive, on `timestamp`, as ISO 8601 UTC with milliseconds.
 */
const appliedInstant = z.iso.datetime({ precision: 3 });
export const appliedRangeSchema = z
  .object({
    from: appliedInstant.meta({
      description:
        "Inclusive start the server applied (ISO 8601 UTC, milliseconds): the request's `from`, or `to` minus 24 hours when `from` was absent, never before 1900-01-01T00:00:00.000Z.",
      example: '2026-11-01T00:00:00.000Z',
    }),
    to: appliedInstant.meta({
      description:
        "Exclusive end the server applied (ISO 8601 UTC, milliseconds): the request's `to`, or the server clock when `to` was absent, never after 2299-12-31T23:59:59.999Z.",
      example: '2026-12-01T00:00:00.000Z',
    }),
  })
  .refine((range) => range.from < range.to, 'The range must start before it ends.')
  .meta({
    description:
      'The time window this read applied: events with `range.from` <= `timestamp` < `range.to`. Without `from`, the server uses at most the 24 hours before `to`, so compare this with the window you meant. Absent from servers older than this field.',
  });
export type AppliedRange = z.infer<typeof appliedRangeSchema>;
/**
 * `GET /v1/project`: how far back the caller's history reaches, so a reader can tell "nothing happened before X" from
 * "older events are no longer stored". `oldestEventAt` is the `timestamp` of the first event a search in `order=asc` over
 * the widest window returns to the same caller: within its scope for a scoped key or viewer token. `retentionDays` is the
 * project's policy, the same for every reader of the project.
 */
export const historyHorizonSchema = z
  .object({
    retentionDays: z.number().int().positive().meta({
      description:
        "The project's retention policy in days, the same for every reader of the project. Each retention run (hourly, and right after the window is shortened) deletes for good the events dated more than this many days before the run. Between runs, older events can still be stored and found, so this is not a bound on what a search returns.",
      example: 90,
    }),
    oldestEventAt: appliedInstant.nullable().meta({
      description:
        'The `timestamp` of the oldest event this caller can find through search (ISO 8601 UTC, milliseconds): the first event of an `order=asc` search over the widest window, or null when that search finds none. It describes what is stored now: retention or deletion may have removed older events, raising `retentionDays` brings none back, and it can move back as well as forward (an event can arrive dated in the past).',
      example: '2026-08-28T09:15:02.481Z',
    }),
  })
  .meta({
    description:
      'How far back the caller can read. To read a whole history, search from `oldestEventAt` to a `to` more than a day after now (an event can be dated up to one day after it was received), and do not take an empty answer before `oldestEventAt` as proof that nothing happened.',
  });
export type HistoryHorizon = z.infer<typeof historyHorizonSchema>;
/** `GET /v1/export` states the applied window in headers (a CSV or JSONL stream has no envelope for a field). */
export const RANGE_FROM_HEADER = 'X-Logbird-Range-From';
export const RANGE_TO_HEADER = 'X-Logbird-Range-To';

export const EXPORT_SCHEMA_VERSION = 1 as const;
export const EXPORT_ID_HEADER = 'X-Logbird-Export-Id';
export const EXPORT_SCHEMA_HEADER = 'X-Logbird-Export-Schema';
export const exportFormatSchema = z.enum(['csv', 'jsonl', 'jsonl-evidence']);
export type ExportFormat = z.infer<typeof exportFormatSchema>;
export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  'jsonl-evidence': 'Complete (original payloads)',
  csv: 'Spreadsheet (CSV)',
  jsonl: 'JSON Lines (all fields)',
};
export const exportQuerySchema = rangeQuerySchema.extend({ format: exportFormatSchema });
export type ExportQuery = z.infer<typeof exportQuerySchema>;
export const exportEvidenceRowSchema = z.object({ exportSchemaVersion: z.literal(EXPORT_SCHEMA_VERSION), event: eventSchema, payload: z.unknown() });
export const exportNormalizedRowSchema = eventSchema.extend({ exportSchemaVersion: z.literal(EXPORT_SCHEMA_VERSION) });
export type ExportNormalizedRow = z.infer<typeof exportNormalizedRowSchema>;
export type ExportEvidenceRow = z.infer<typeof exportEvidenceRowSchema>;
export const exportStatusSchema = z.object({
  exportId: z.uuid(),
  state: z.enum(['pending', 'completed', 'failed', 'unknown']),
  reason: z.string().max(64).nullable(),
  description: z.string().nullable(),
});
export type ExportStatus = z.infer<typeof exportStatusSchema>;

export const searchQuerySchema = rangeQuerySchema.extend({
  cursor: z.string().optional(), // opaque, returned as nextCursor
  limit: z.coerce.number().int().min(1).max(200).default(50),
  order: z.enum(['desc', 'asc']).default('desc'),
});
/** `lang` on /v1: only the query language (SQL mode is console-only). */
const publicLang = z
  .literal('query')
  .optional()
  .meta({ description: 'Only `query` (the default). `lang=sql` is console-only and answers 422 invalid_query.' });
const STORED_TIMESTAMP =
  "the stored `timestamp`: the event's occurredAt, or the time Logbird received it when occurredAt was absent or unusable (an unusable value is usually noted, cut to 256 characters, in `attributes['logbird.occurredAt.rejected']`; the event detail's `payload` keeps what was sent)";
/** The time window and filter of the /v1 reads, described for OpenAPI (the console routes keep the bare schema). */
const publicWindow = {
  from: z
    .string()
    .optional()
    .meta({
      description: `Start of the time window, inclusive, on ${STORED_TIMESTAMP}. Send an ISO 8601 date-time in UTC (Z) or with an offset, read to the millisecond: a date-time without an offset is read in the server's time zone, and a date alone is midnight UTC. The server parses it with JavaScript's Date, so other spellings that Date accepts are read too; they are not portable. Default: \`to\` minus 24 hours. A bound outside what the store holds is moved onto its limit: \`from\` no earlier than 1900-01-01T00:00:00.000Z, \`to\` no later than 2299-12-31T23:59:59.999Z (exclusive, so an event at exactly that last millisecond cannot be read). The window applied is returned as \`range\` (export: the X-Logbird-Range-From and X-Logbird-Range-To headers).`,
      example: '2026-11-01T00:00:00.000Z',
    }),
  to: z.string().optional().meta({
    description:
      'End of the time window, exclusive. Same format as `from`. Default: the server clock when the request is read. `from` must be before `to` (422 invalid_query otherwise).',
    example: '2026-12-01T00:00:00.000Z',
  }),
  q: z.string().max(4096).optional().meta({
    description:
      'Filter in the Logbird query language (docs/query-language.md), at most 4096 UTF-8 bytes. It narrows the time window and never widens it: a time term (such as `receivedAt:>…`) applies inside the window. A relative time (such as `receivedAt:>now-1h`) is read against the clock of each request.',
    example: 'action:document.updated',
  }),
  lang: publicLang,
};
export const publicSearchQuerySchema = searchQuerySchema.extend({
  ...publicWindow,
  cursor: z.string().optional().meta({
    description:
      "The `nextCursor` of the previous page (opaque). The next page starts after that page's last event in the sort order. Send the same `q`, `order`, `from` and `to` with it: a cursor carries no window, so without `from` and `to` each page computes its own default window. To keep the same window and filter on every page, send the first page's `range` back as `from` and `to`, and use absolute times in `q`; the pages still see events stored or removed while you page. A cursor this server issues works only for the project and reader scope that received it (422 validation_error otherwise).",
  }),
  limit: z.coerce.number().int().min(1).max(200).default(50).meta({ description: 'Events per page, 1 to 200 (default 50).' }),
  order: z.enum(['desc', 'asc']).default('desc').meta({
    description:
      '`desc` (default) is newest first, `asc` oldest first. Events sort by `timestamp`, then by event `id` in the same direction. Events in the same millisecond are ordered by id, not by cause: read causation from `context.parentEventId`.',
  }),
});
/** `GET /v1/export`: the console schema without SQL mode (`lang=sql` is console-only). */
export const publicExportQuerySchema = exportQuerySchema.extend({
  ...publicWindow,
  format: exportFormatSchema.meta({
    description:
      '`csv`, `jsonl` (one event per line) or `jsonl-evidence` (each event with its original payload; 422 masked_export for a masked scope).',
  }),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchResponseSchema = z.object({
  data: z.array(eventSchema).meta({ description: 'This page of events, in the requested `order`.' }),
  nextCursor: z.string().nullable().meta({ description: 'Send as `cursor` for the next page; null on the last page.' }),
  /** Number of matches in range. When `totalExact` is false it is a lower bound (capped at 10,001, or the count did not finish). */
  total: z.number().int().meta({
    description: 'Matching events in the whole window (every page, not only this one). A lower bound when `totalExact` is false.',
  }),
  /** False when `total` is a lower bound. Absent from older servers: treat as exact below 10,001. */
  totalExact: z.boolean().optional().meta({
    description:
      'False when `total` is a lower bound because the server could not establish an exact count: the count stops at 10,001, failed, did not finish within its 1 second budget, or saw fewer events than this page proves. Exact means exact for `range`: events outside the window are not counted. Absent from older servers: treat as exact below 10,001.',
  }),
  /** The window applied (absent from older servers). */
  range: appliedRangeSchema.optional(),
  tookMs: z.number(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

/**
 * Histogram bucket ladder (seconds). When `interval` is omitted the server picks the smallest step that keeps the
 * range at ≤ ~120 buckets (multiples of 1d beyond that). Buckets are aligned to UTC boundaries of their size, so
 * hourly-and-larger buckets always start on whole hours.
 */
export const HISTOGRAM_LADDER = [60, 300, 600, 900, 1800, 3600, 10_800, 21_600, 43_200, 86_400] as const;
export const HISTOGRAM_TARGET_BUCKETS = 120;
export function pickHistogramInterval(rangeMs: number, target = HISTOGRAM_TARGET_BUCKETS): number {
  const seconds = Math.max(1, rangeMs / 1000);
  // One bucket of slack: a "30d" window that ends a few ms after now must still get 6h buckets.
  const step = HISTOGRAM_LADDER.find((c) => seconds / c <= target + 1);
  return step ?? 86_400 * Math.ceil(seconds / 86_400 / target);
}

export const histogramQuerySchema = rangeQuerySchema.extend({
  /** Bucket size in seconds; server picks one from HISTOGRAM_LADDER (≤ ~120 buckets) when omitted. */
  interval: z.coerce.number().int().min(1).optional(),
});
export const histogramResponseSchema = z.object({
  interval: z.number().int(),
  buckets: z.array(
    z.object({
      ts: z.string(),
      total: z.number().int(),
      byOutcome: z.record(z.string(), z.number().int()),
    }),
  ),
});
export type HistogramResponse = z.infer<typeof histogramResponseSchema>;

export const FACET_FIELDS = [
  'action',
  'category',
  'outcome',
  'severity',
  'environment',
  'actor.type',
  'actor',
  'impersonator',
  'tenant',
  'executor',
  'executor.type',
  'target',
  'target.type',
  'source',
] as const;
/** Facets group stored fields. Virtual selectors such as record: are available in q. */
export const FACETABLE_FIELDS = [
  ...new Set([...FACET_FIELDS, ...QUERY_FIELDS.filter(({ column }) => column).flatMap(({ key, aliases }) => [key, ...(aliases ?? [])])]),
] as [string, ...string[]];
/** Any envelope field, or any attribute key as `attr.<path>` or `attributes.<path>` (array-valued attributes count each element). */
export const facetFieldSchema = z.union([
  z.enum(FACETABLE_FIELDS),
  // The stored path after the prefix is bounded (4096, the query bound) the same way for `attr.` and `attributes.`.
  z
    .string()
    .regex(/^(?:attr|attributes)\..+/)
    .refine((field) => field.replace(/^(?:attr|attributes)\./, '').length <= 4096, 'Attribute path exceeds 4096 characters.')
    .meta({ description: '`attr.<path>` or `attributes.<path>`; the path after the prefix is at most 4096 characters.' }),
]);
export const facetQuerySchema = rangeQuerySchema.extend({
  field: facetFieldSchema.meta({
    description: 'The field to count: a stored field, or an attribute as `attr.<path>` (array-valued attributes count each element).',
    example: 'attr.metadata.missing',
  }),
  limit: z.coerce.number().int().min(1).max(100).default(10).meta({
    description:
      'Values returned, 1 to 100 (default 10), most frequent first. Counts cover the events in the time window (`range`) that match `q`; `otherCount` counts what the listed values leave out.',
  }),
  /** Optional second level (#140): the top `byLimit` values of `by` within each returned value of `field`. */
  by: facetFieldSchema
    .optional()
    .meta({ description: 'Optional second field: the top `byLimit` values of `by` within each returned value of `field`.', example: 'tenant' }),
  byLimit: z.coerce.number().int().min(1).max(20).default(5).meta({ description: 'Second-level values per value of `field`, 1 to 20 (default 5).' }),
});
const facetValueSchema = z.object({ value: z.string(), label: z.string(), count: z.number().int() });
export const facetResponseSchema = z.object({
  field: z.string(),
  /** The second-level field when `by` was requested, else null. */
  by: z.string().nullable(),
  values: z.array(
    facetValueSchema.extend({
      /** Present only with `by`: top values of `by` among this value's events, and the count of the rest. */
      groups: z.array(facetValueSchema).optional(),
      groupsOtherCount: z.number().int().optional(),
    }),
  ),
  otherCount: z.number().int(),
  /** The window applied (absent from older servers). */
  range: appliedRangeSchema.optional(),
});
export type FacetResponse = z.infer<typeof facetResponseSchema>;
/** `GET /v1/facets`: the console schema without SQL mode (`lang=sql` is console-only). */
/**
 * The overview's "Recent problems": events whose outcome is one of these OR whose severity is this. The server lists
 * them and the console's "View all" opens exactly the same group, both from these constants.
 */
export const RECENT_PROBLEM_OUTCOMES = ['failure', 'denied'] as const;
export const RECENT_PROBLEM_SEVERITY = 'critical';

export const publicFacetQuerySchema = facetQuerySchema.extend(publicWindow);

/* ------------------------------------------------------------------ */
/* Overview dashboard                                                  */
/* ------------------------------------------------------------------ */

const topItem = z.object({ id: z.string(), label: z.string(), count: z.number().int() });

export const overviewResponseSchema = z.object({
  kpis: z.object({
    events: z.number().int(),
    eventsPrev: z.number().int(), // same-length previous window, for deltas
    actors: z.number().int(),
    actorsPrev: z.number().int(),
    tenants: z.number().int(),
    failureRate: z.number(), // 0..1 (failure + denied) / total
    failureRatePrev: z.number(),
    avgConformance: z.number(), // 0..100
  }),
  series: histogramResponseSchema,
  topActions: z.array(topItem),
  topActors: z.array(topItem.extend({ type: z.string() })),
  topTenants: z.array(topItem),
  topExecutors: z.array(topItem.extend({ type: z.string() })),
  recentProblems: z.array(eventSchema), // latest RECENT_PROBLEM_OUTCOMES or RECENT_PROBLEM_SEVERITY events
  ingest: z.object({
    lastEventAt: z.string().nullable(),
    eventsLastHour: z.number().int(),
    perMinute: z.array(z.object({ ts: z.string(), count: z.number().int() })), // last 60 min sparkline
  }),
});
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;

/* ------------------------------------------------------------------ */
/* Entities: actors, tenants, executors, targets                       */
/* ------------------------------------------------------------------ */

export const ENTITY_KINDS = ['actor', 'tenant', 'executor', 'target'] as const;
export const entityKindSchema = z.enum(ENTITY_KINDS);
export type EntityKind = z.infer<typeof entityKindSchema>;

export const entitySchema = z.object({
  kind: entityKindSchema,
  id: z.string(), // for targets: "<type>:<id>"
  type: z.string(), // actor.type / executor.type / target.type; "" for tenants
  name: z.string(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  events: z.number().int(),
});
export type Entity = z.infer<typeof entitySchema>;

export const ENTITY_SORTS = ['events', 'lastSeen', 'name'] as const;
export const entitySortSchema = z.enum(ENTITY_SORTS);
export type EntitySort = z.infer<typeof entitySortSchema>;

export const entityListQuerySchema = z.object({
  kind: entityKindSchema,
  /**
   * Search by id and name. Results rank by match first (exact id, id prefix, name prefix, substring, fuzzy; a record's
   * bare id counts as its id), then by `sort`, so an exact id always leads whatever the limit. One or two characters
   * match only ids and names that start with them.
   */
  q: z.string().max(1024).optional(),
  type: z.string().optional(),
  /** events: most active first (then most recently seen); lastSeen: most recent first; name: A→Z. */
  sort: entitySortSchema.default('events'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export const entityListResponseSchema = z.object({ data: z.array(entitySchema), nextCursor: z.string().nullable() });

export const entityMetadataQuerySchema = z.object({
  /** For targets, selects the original type when more than one pair can share the composite entity id. */
  targetType: z.string().max(64).optional(),
});
export const entityMetadataSchema = entitySchema.pick({ kind: true, id: true, type: true, name: true });
export type EntityMetadata = z.infer<typeof entityMetadataSchema>;

export const entityProfileQuerySchema = rangeQuerySchema.extend(entityMetadataQuerySchema.shape);
export type EntityProfileQuery = z.infer<typeof entityProfileQuerySchema>;

export const entityProfileSchema = z.object({
  entity: entitySchema,
  series: histogramResponseSchema, // activity over requested range
  topActions: z.array(topItem),
  outcomes: z.record(z.string(), z.number().int()),
  /** Related entities, e.g. tenants an actor touched, actors acting on a target. */
  related: z.array(entitySchema.pick({ kind: true, id: true, type: true, name: true }).extend({ count: z.number().int() })),
});
export type EntityProfile = z.infer<typeof entityProfileSchema>;

/* ------------------------------------------------------------------ */
/* Projects, keys, views, fields                                       */
/* ------------------------------------------------------------------ */

export const RETENTION_OPTIONS = [7, 14, 30, 60, 90, 180, 365, 730, 1825, 3650] as const;

export const projectSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  retentionDays: z.number().int(),
  createdAt: z.string(),
  lastEventAt: z.string().nullable(),
  eventsLast24h: z.number().int(),
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectSchema = z.object({
  name: z.string().min(2).max(64),
  description: z.string().max(280).optional(),
  retentionDays: z
    .number()
    .int()
    .refine((v) => (RETENTION_OPTIONS as readonly number[]).includes(v))
    .default(90),
});
export const updateProjectSchema = z.object({
  name: z.string().min(2).max(64).optional(),
  description: z.string().max(280).nullable().optional(),
  retentionDays: z
    .number()
    .int()
    .refine((v) => (RETENTION_OPTIONS as readonly number[]).includes(v))
    .optional(),
  /** Required when lowering retention: must equal the project slug. Data past the new window is PERMANENTLY deleted. */
  confirm: z.string().optional(),
  /** Marks the setup "retention" step as reviewed (any retentionDays change also marks it). */
  retentionReviewed: z.literal(true).optional(),
  /** true hides the overview setup card for the whole workspace; false re-opens it. */
  setupDismissed: z.boolean().optional(),
});

/**
 * `ingest` writes; `read` reads the whole project and may mint viewer tokens for any scope; `scoped-read` reads only
 * within its fixed `scope` and may mint viewer tokens for an equal or narrower scope. All read kinds use `lb_read_…`.
 */
export const API_KEY_KINDS = ['ingest', 'read', 'scoped-read'] as const;
export const apiKeyKindSchema = z.enum(API_KEY_KINDS);
export type ApiKeyKind = z.infer<typeof apiKeyKindSchema>;

/** Field-mask presets. Any active mask also drops the raw `payload` (detail → null, export → refused for jsonl-evidence). */
export const SCOPE_MASKS = ['ip', 'user_agent', 'actor_email'] as const;
export const scopeMaskSchema = z.enum(SCOPE_MASKS);

/**
 * A read scope, enforced by the server as a mandatory predicate ANDed outside the caller's `q` on every scoped read
 * (search, detail, parents/children/operation counts, facets, export). Nothing in `q` can widen it.
 * - `tenantId`: the event's `tenant.id` must equal it. Events without a tenant are never visible to a scoped caller.
 * - `target`: the event must have a target with exactly this type and id (e.g. `{type: 'website', id: 'site_42'}`).
 * - `actionPrefixes`: the action must start with one of these prefixes (e.g. `booking.`).
 * - `mask`: field-mask presets applied to every returned event.
 * v1 allows one tenant per scope; the shape stays list-ready (a future `tenantIds` would be additive).
 */
/**
 * Scope identifiers name STORED ids (maintainer decision, #180): they must already be in stored form, with no
 * surrounding whitespace, no U+FFFD, no lone surrogates and no U+0000 (Postgres jsonb cannot store it), and shorter than
 * the stored caps. Then a capped or Unicode-repaired stored value can never equal a valid scope id.
 */
const scopeIdentifier = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (v) =>
        v === v.trim() &&
        !v.includes(String.fromCharCode(0)) &&
        !/\uFFFD|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v),
      'Use the identifier exactly as stored: no surrounding whitespace, NUL or invalid Unicode.',
    );
export const readScopeSchema = z
  .object({
    tenantId: scopeIdentifier(250).meta({ example: 'biz_5' }),
    target: z
      .object({ type: scopeIdentifier(60), id: scopeIdentifier(250) })
      .strict()
      .optional()
      .meta({ example: { type: 'website', id: 'site_42' } }),
    actionPrefixes: z
      .array(scopeIdentifier(190))
      .min(1)
      .max(20)
      .optional()
      .meta({ example: ['booking.', 'auth.'] }),
    mask: z
      .array(scopeMaskSchema)
      .min(1)
      .max(SCOPE_MASKS.length)
      .optional()
      .meta({
        example: ['ip', 'user_agent'],
        description:
          'Field masks applied to every returned event. `ip` and `user_agent` empty `context.ip` and `context.userAgent`. `actor_email` shows `actor.email`, the impersonator email attribute `impersonator.email` and an actor or impersonator name that carries an address (contains `@` or a compatibility form of it, equals the email, or is 511 UTF-16 units or longer) as `masked:<24 hex>` pseudonyms, stable per project (impersonator pseudonyms are keyed by role, so they do not match the actor pseudonym of the same address), and removes attribute paths below `impersonator.email`. Every protected attribute path below covers the paths below it too, which are removed from events, and matches attribute keys in any ASCII letter case (`impersonator.Email`). A masked scope cannot filter or facet on what its masks hide (422 `invalid_query`, reason `not_allowed`): for `ip` the `ip` field and the `context.ip` attribute; for `user_agent` the `context.userAgent` attribute; for `actor_email` the `actor.email` field and attribute, the literal `actor.name` and `impersonator.name` attributes (removed from events too), and the `impersonator.email` attribute (as a facet, `field=attr.impersonator.email`). Other names stay readable: `actor.name` and `impersonator.name` filters read an address-carrying name as empty, and facets on `actor.name`, `actor`, `impersonator` and `impersonator.name` show an address-carrying name (as a value or label) as its pseudonym. Any mask drops the original payload. See docs/scoped-read-access.md#masks.',
      }),
  })
  .strict();
export type ReadScope = z.infer<typeof readScopeSchema>;

/** `https://host[:port]` (or `http://localhost[:port]`), exactly as a browser sends `Origin`. */
export const embedOriginSchema = z
  .string()
  .max(255)
  .regex(
    /^(https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|http:\/\/(localhost|127\.0\.0\.1))(:\d{1,5})?$/,
    'Use a lowercase origin such as https://app.example.com (no path or trailing slash).',
  );

export const apiKeySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  kind: apiKeyKindSchema,
  prefix: z.string(), // e.g. "lb_ingest_7Hq2"; full secret only returned once on create
  /** `scoped-read` only: the fixed scope enforced on every read and viewer token (null for other kinds). */
  scope: readScopeSchema.nullable(),
  /** Read kinds: browser origins allowed to use this key's viewer tokens (CORS) and, later, to frame the embed viewer. */
  embedOrigins: z.array(z.string()),
  /** Optional expiry. An expired key is rejected like a revoked one, and so are its viewer tokens. */
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.object({ id: z.string(), name: z.string(), email: z.string().optional() }).nullable(),
  lastUsedAt: z.string().nullable(),
  /** User agent of the most recent authenticated request (sampled with lastUsedAt, at most once a minute; ≤ 256 chars). */
  lastUsedUserAgent: z.string().nullable(),
  /** Set when this key was created by rolling another key: the key it replaces (which stays valid until revoked). */
  replacesKeyId: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;
/**
 * Create a key. `scope` is required for `scoped-read` and rejected otherwise. `embedOrigins` is for read kinds only.
 * `expiresAt` must be in the future. Scope, origins and expiry are fixed at creation; change them by creating a new key.
 * Rolling copies scope and origins, and keeps the old key's absolute expiry unless the roll passes a new one
 * (`rollApiKeySchema`): a replacement never silently outlives the key it replaces.
 */
export const createApiKeySchema = z
  .object({
    name: z.string().min(1).max(64),
    kind: apiKeyKindSchema,
    scope: readScopeSchema.optional(),
    embedOrigins: z.array(embedOriginSchema).max(10).optional(),
    expiresAt: z.iso.datetime().optional(),
  })
  .superRefine((input, ctx) => {
    if ((input.kind === 'scoped-read') !== (input.scope !== undefined))
      ctx.addIssue({ code: 'custom', path: ['scope'], message: 'A scope is required for scoped-read keys and only allowed on them.' });
    if (input.kind === 'ingest' && input.embedOrigins?.length)
      ctx.addIssue({ code: 'custom', path: ['embedOrigins'], message: 'Embed origins apply to read keys only.' });
  });
export const createApiKeyResponseSchema = z.object({ key: apiKeySchema, secret: z.string() });
/**
 * Optional body of `POST …/keys/:keyId/roll`. Without `expiresAt` the replacement keeps the old key's absolute expiry
 * (none stays none); with it, the replacement expires then (must be in the future). Rolling a key that has already
 * expired requires a new `expiresAt` (409 `key_expired` otherwise).
 */
export const rollApiKeySchema = z.object({ expiresAt: z.iso.datetime().optional() }).strict();

export const VIEWER_TOKEN_TTL_SECONDS = { min: 60, default: 900, max: 3600 } as const;
/**
 * `POST /v1/viewer-tokens` (read or scoped-read key). The token's scope must be equal to or narrower than the key's:
 * a `read` key may mint any scope; a `scoped-read` key only its own tenant and target, with a subset of its action
 * prefixes and at least its masks.
 */
export const viewerTokenRequestSchema = z
  .object({
    scope: readScopeSchema,
    ttlSeconds: z.number().int().min(VIEWER_TOKEN_TTL_SECONDS.min).max(VIEWER_TOKEN_TTL_SECONDS.max).default(VIEWER_TOKEN_TTL_SECONDS.default),
  })
  .strict();
export const viewerTokenResponseSchema = z.object({
  /** `lbv1.<payload>.<mac>`; send as `Authorization: Bearer …` to the /v1 read routes. Never put it in a URL query. */
  token: z.string(),
  expiresAt: z.string(),
  scope: readScopeSchema,
});
export type ViewerTokenResponse = z.infer<typeof viewerTokenResponseSchema>;

export const createProjectResponseSchema = z.object({ project: projectSchema, ingestKey: createApiKeyResponseSchema });

export const savedViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** Serialized explorer state: q, relative/absolute range, visible columns. */
  state: z.object({
    q: z.string().optional(),
    /** Language of `q`; absent = 'query' (views saved before SQL mode). */
    lang: queryLangSchema.optional(),
    range: z.string().optional(), // "24h" | "7d" | "<isoFrom>..<isoTo>"
    columns: z.array(z.string()).optional(),
    /**
     * Display names for entity terms in `q` (e.g. `tenant:biz_5` → "Bayt Al Rimal"), captured when the view is saved so
     * cards and the save dialog can say "Tenant: Bayt Al Rimal" instead of a raw id. Purely presentational.
     */
    labels: z
      .array(
        z.object({
          field: z.enum(['actor', 'tenant', 'executor', 'target', 'record', 'impersonator']),
          value: z.string().max(512),
          label: z.string().max(200),
        }),
      )
      .max(20)
      .optional(),
  }),
  createdBy: z.object({ id: z.string(), name: z.string(), email: z.string().optional() }).nullable(),
  createdAt: z.string(),
});
export type SavedView = z.infer<typeof savedViewSchema>;
/** Query and SQL expressions are compiled by the server before a view is persisted. */
export const createSavedViewSchema = savedViewSchema.pick({ name: true, description: true, state: true });

export const fieldInfoSchema = z.object({
  /** Core column ("actor.id") or attribute key ("attr.metadata.plan"). */
  key: z.string(),
  kind: z.enum(['core', 'attribute']),
  coverage: z.number(), // 0..1 share of events in range that carry it
  distinctApprox: z.number().int(),
  samples: z.array(z.string()).max(5),
  lastSeen: z.string().nullable(),
});
export const fieldsResponseSchema = z.object({ data: z.array(fieldInfoSchema), avgConformance: z.number() });

export const meResponseSchema = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string(), image: z.string().nullable() }),
  organizations: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), role: z.string() })),
  activeOrganizationId: z.string().nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/**
 * 409 from a console project route (session only): the project belongs to another workspace that the signed-in person
 * is a current member of, so the console can offer to switch to it. A project in a workspace the person is not a member
 * of, or no such project, is the same 404 `not_found`, so a project id never reveals a workspace.
 */
export const PROJECT_IN_OTHER_WORKSPACE = 'project_in_other_workspace';
export const projectInOtherWorkspaceErrorSchema = z
  .object({
    error: z.object({
      code: z.literal(PROJECT_IN_OTHER_WORKSPACE),
      message: z.string(),
      details: z.object({ workspaceId: z.string(), workspaceName: z.string() }),
    }),
  })
  .describe(
    'The project is in another workspace you are a member of (details name it). Switch the active workspace to open it. ' +
      'A project in a workspace you are not a member of returns 404 not_found, like a project that does not exist.',
  );
export type ProjectInOtherWorkspaceError = z.infer<typeof projectInOtherWorkspaceErrorSchema>;

/**
 * `GET /api/onboarding/workspace-name` — what the onboarding workspace step pre-fills. `name` is null when the email
 * domain is a personal mailbox provider, or a workspace member or pending invitation already uses that domain (a
 * teammate should join that workspace instead of creating a look-alike).
 */
export const workspaceNameSuggestionSchema = z.object({ name: z.string().nullable() });
export type WorkspaceNameSuggestion = z.infer<typeof workspaceNameSuggestionSchema>;

/** DELETE project query: missing/wrong confirmation is rejected before deletion. */
export const deleteProjectQuerySchema = z.object({ confirm: z.string().optional() });
