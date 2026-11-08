import { z } from 'zod';
import { eventSchema } from './events';
import { queryLangSchema } from './query';
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
export const rangeQuerySchema = z.object({
  from: z.string().optional(), // ISO; default now-24h
  to: z.string().optional(), // ISO; default now
  q: z.string().max(4096).optional().meta({ example: 'action:document.updated' }),
  lang: queryLangSchema.optional(), // absent = 'query'
});
export type RangeQuery = z.infer<typeof rangeQuerySchema>;

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
export const publicSearchQuerySchema = searchQuerySchema.extend({ lang: z.literal('query').optional() });
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchResponseSchema = z.object({
  data: z.array(eventSchema),
  nextCursor: z.string().nullable(),
  /** Approximate number of matches in range (may be capped / estimated for huge ranges). */
  total: z.number().int(),
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
export const facetQuerySchema = rangeQuerySchema.extend({
  field: z.union([z.enum(FACET_FIELDS), z.string().regex(/^attr\..+/)]),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});
export const facetResponseSchema = z.object({
  field: z.string(),
  values: z.array(z.object({ value: z.string(), label: z.string(), count: z.number().int() })),
  otherCount: z.number().int(),
});
export type FacetResponse = z.infer<typeof facetResponseSchema>;

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
  recentProblems: z.array(eventSchema), // latest failure/denied/critical
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
  q: z.string().max(200).optional(), // fuzzy match on id + name
  type: z.string().optional(),
  /** events: most active first (then most recently seen); lastSeen: most recent first; name: A→Z. */
  sort: entitySortSchema.default('events'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export const entityListResponseSchema = z.object({ data: z.array(entitySchema), nextCursor: z.string().nullable() });

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

export const API_KEY_KINDS = ['ingest', 'read'] as const;
export const apiKeySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  kind: z.enum(API_KEY_KINDS),
  prefix: z.string(), // e.g. "lb_ingest_7Hq2"; full secret only returned once on create
  createdAt: z.string(),
  createdBy: z.object({ id: z.string(), name: z.string(), email: z.string().optional() }).nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;
export const createApiKeySchema = z.object({ name: z.string().min(1).max(64), kind: z.enum(API_KEY_KINDS) });
export const createApiKeyResponseSchema = z.object({ key: apiKeySchema, secret: z.string() });

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

/** DELETE project query: missing/wrong confirmation is rejected before deletion. */
export const deleteProjectQuerySchema = z.object({ confirm: z.string().optional() });
