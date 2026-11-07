import { z } from 'zod';

/**
 * Logbird accepts ANY JSON object as an event. Only `action` is required.
 * The fields below are the *recommended* envelope: when present they are lifted
 * into first-class, indexed ClickHouse columns. Everything else is flattened into
 * `attributes` (searchable) and the raw document is always kept in `payload`.
 */

export const OUTCOMES = ['success', 'failure', 'denied', 'partial', 'unknown'] as const;
export const SEVERITIES = ['info', 'notice', 'warning', 'critical'] as const;
export const ACTOR_TYPES = ['user', 'service', 'system', 'api_key', 'integration', 'anonymous'] as const;
export const EXECUTOR_TYPES = ['api', 'worker', 'scheduler', 'webhook', 'script', 'service'] as const;

export const outcomeSchema = z.enum(OUTCOMES);
export const severitySchema = z.enum(SEVERITIES);

const id = z.string().min(1).max(256);
const shortText = z.string().max(512);

export const actorInputSchema = z.looseObject({
  type: z.string().max(64).optional(), // recommended: one of ACTOR_TYPES
  id: id.optional(),
  name: shortText.optional(),
  email: shortText.optional(),
});

export const executorInputSchema = z.looseObject({
  type: z.string().max(64).optional(), // recommended: one of EXECUTOR_TYPES
  id: id.optional(),
  name: shortText.optional(),
  jobId: id.optional(),
  attempt: z.number().int().min(0).max(65_535).optional(),
});

export const targetInputSchema = z.looseObject({
  type: z.string().min(1).max(64),
  id,
  name: shortText.optional(),
});

export const changeInputSchema = z.object({
  field: z.string().min(1).max(256),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

export const contextInputSchema = z.looseObject({
  operationId: id.optional(),
  parentEventId: id.optional(),
  requestId: id.optional(),
  traceId: id.optional(),
  ip: z.string().max(64).optional(),
  userAgent: z.string().max(1024).optional(),
});

/** What clients send. Loose on purpose: unknown keys are accepted and stored. */
export const eventInputSchema = z.looseObject({
  id: z
    .string()
    .min(1)
    .refine(
      (value) => value.trim().length <= 256 && !value.includes('\u0000') && !/[\uD800-\uDFFF]/u.test(value),
      'trimmed id must be valid Unicode, at most 256 UTF-16 code units, without NUL',
    )
    .describe('Stable string id. The trimmed key is limited to 256 UTF-16 code units. Retries resend identical parsed content.')
    .optional(), // stable event id; retries resend identical content
  action: z.string().min(1).max(200),
  occurredAt: z.union([z.string(), z.number()]).optional(), // ISO-8601 or epoch ms; defaults to receive time
  environment: z.string().max(64).optional(), // default "production"
  outcome: z.string().max(32).optional(), // recommended: one of OUTCOMES; default "success"
  severity: z.string().max(32).optional(), // recommended: one of SEVERITIES; default "info"
  description: z.string().max(4096).optional(),
  actor: actorInputSchema.optional(),
  impersonator: actorInputSchema.optional(),
  executor: executorInputSchema.optional(),
  tenant: z.looseObject({ id, name: shortText.optional() }).optional(),
  source: z.string().max(128).optional(), // external system that supplied the change, e.g. "channel-manager"
  targets: z.array(targetInputSchema).max(64).optional(),
  changes: z.array(changeInputSchema).max(256).optional(),
  context: contextInputSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  schemaVersion: z.string().max(32).optional(),
});
export type EventInput = z.infer<typeof eventInputSchema>;

/** Ingest body: a single event or a batch. Max 1000 events / 5 MB per request. */
export const ingestBodySchema = z.union([
  z.array(z.unknown()).min(1).max(1000),
  z.object({ events: z.array(z.unknown()).min(1).max(1000) }),
  z.record(z.string(), z.unknown()),
]);

export const ingestResponseSchema = z.object({
  accepted: z.number().int(),
  ids: z.array(z.string()),
  /** Conflicts start with duplicate_id_conflict: followed by actionable guidance. Original content is kept. */
  rejected: z.array(z.object({ index: z.number().int(), reason: z.string(), code: z.string() })),
  /** Accepted events that were adjusted, e.g. an unusable occurredAt stored at receive time (original kept in attributes). */
  warnings: z.array(z.object({ index: z.number().int(), reason: z.string() })).default([]),
});
export type IngestResponse = z.infer<typeof ingestResponseSchema>;
/** 503 ingest_pending: siblings commit first. Every index outside indices is settled; retry the identical batch with Retry-After. */
export const ingestPendingDetailsSchema = ingestResponseSchema.extend({
  indices: z.array(z.number().int().nonnegative()),
  eventIds: z.array(z.string()),
});

/** Normalized event as returned by every read API. */
export const eventSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  timestamp: z.string(), // ISO-8601 UTC, ms precision
  receivedAt: z.string(),
  environment: z.string(),
  action: z.string(),
  category: z.string(), // first segment of action ("hotel" for "hotel.policy.updated")
  outcome: z.string(),
  severity: z.string(),
  description: z.string(),
  actor: z.object({ type: z.string(), id: z.string(), name: z.string(), email: z.string() }).nullable(),
  impersonator: z.object({ id: z.string(), name: z.string() }).nullable(),
  executor: z.object({ type: z.string(), id: z.string(), name: z.string(), jobId: z.string(), attempt: z.number() }).nullable(),
  tenant: z.object({ id: z.string(), name: z.string() }).nullable(),
  source: z.string().nullable(),
  targets: z.array(z.object({ type: z.string(), id: z.string(), name: z.string() })),
  changes: z.array(z.object({ field: z.string(), before: z.string(), after: z.string() })),
  context: z.object({
    operationId: z.string(),
    parentEventId: z.string(),
    requestId: z.string(),
    traceId: z.string(),
    ip: z.string(),
    userAgent: z.string(),
  }),
  attributes: z.record(z.string(), z.string()),
  conformance: z.number(), // 0..100: share of recommended envelope fields present
  schemaVersion: z.string(),
  sdk: z.string(),
});
export type AuditEvent = z.infer<typeof eventSchema>;

export const eventDetailSchema = z.object({
  event: eventSchema,
  payload: z.unknown(), // raw JSON exactly as received
  parents: z.array(eventSchema), // causation chain root -> direct parent
  childCount: z.number().int(),
  operationSize: z.number().int(), // events sharing context.operationId
});
export type EventDetail = z.infer<typeof eventDetailSchema>;
