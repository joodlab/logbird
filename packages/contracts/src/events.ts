import { z } from 'zod';
import { isRawJson, type RawJson } from './json';

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

/**
 * What one event keeps in its indexed columns (what search, facets, `record:` and exports read). Over a limit the event
 * is still accepted and its stored `payload` keeps everything sent; only `payloadBytes` rejects the event. Cuts of
 * targets, changes and change field names come back as ingest `warnings` and are recorded on the event in the
 * reserved `logbird.truncated.*` attributes (see TRUNCATED_ATTRIBUTES). docs/limits.md lists every limit.
 */
export const EVENT_LIMITS = {
  /** Targets indexed per event, in the order sent. */
  targets: 64,
  /** Changes indexed per event, in the order sent. */
  changes: 256,
  /** UTF-16 code units of a change's `field` that are indexed. */
  changeField: 256,
  /** Attribute keys indexed per event (fields outside the envelope, flattened). */
  attributes: 256,
  /** UTF-8 bytes of one attribute value that are indexed. */
  attributeBytes: 2048,
  /** Path segments of an attribute key: a deeper object is indexed as JSON text at this depth. */
  attributeDepth: 6,
  /** UTF-16 code units of `description` that are indexed. */
  description: 4096,
  /** Serialized size of one event; a larger event is rejected (invalid_event), its siblings are still stored. */
  payloadBytes: 256 * 1024,
} as const;
/**
 * Reserved attributes Logbird sets on an event whose targets, changes or change field names were cut at ingest. Each
 * holds a count as decimal text: the targets sent, the changes sent, the change field names that were cut. Only
 * Logbird sets them: a value the producer sends under `logbird.truncated` is dropped from the attributes (the payload
 * keeps it), so they can be neither forged nor collided with.
 */
export const TRUNCATED_ATTRIBUTES = {
  targets: 'logbird.truncated.targets',
  changes: 'logbird.truncated.changes',
  changeFields: 'logbird.truncated.changeFields',
} as const;
export const TRUNCATED_ATTRIBUTE_PREFIX = 'logbird.truncated';
/** Per-request limits of ingest and of the /v1 reads. docs/limits.md lists them (a test checks the numbers). */
export const REQUEST_LIMITS = {
  /** Events per ingest request (413 payload_too_large above). */
  ingestEvents: 1000,
  /** Ingest body bytes after gzip decoding (413 payload_too_large above). */
  ingestBodyBytes: 5 * 1024 * 1024,
  /** Events per search page. */
  pageSize: 200,
  /** Values per facet, and second-level values per value. */
  facetValues: 100,
  facetGroups: 20,
  /** UTF-8 bytes of `q` (422 invalid_query above). */
  queryBytes: 4096,
  /** Terms in `q`, and nesting levels of parentheses (422 invalid_query above). */
  queryTerms: 64,
  queryDepth: 16,
  /** Body of a viewer-token request (413 payload_too_large above). */
  viewerTokenBodyBytes: 16 * 1024,
  /** Search `total` stops counting here (`totalExact: false`). */
  countCap: 10_001,
  /** Parents an event detail walks up `context.parentEventId`. */
  parentDepth: 100,
} as const;

const id = z.string().min(1).max(256);
/** Entity ids may also be numbers (integer keys); a number is stored as the plain decimal of its exact value. */
// parseJsonExact keeps a number a double cannot hold as a raw JSON value with its exact digits.
const rawNumber = z.custom<RawJson>((value) => isRawJson(value) && /^-?\d/.test(value.rawJSON), 'expected a number').meta({ type: 'number' });
const entityId = z.union([id, z.number(), rawNumber]);
const shortText = z.string().max(512);

export const actorInputSchema = z.looseObject({
  type: z.string().max(64).optional(), // recommended: one of ACTOR_TYPES
  id: entityId.optional(),
  name: shortText.optional(),
  email: shortText.optional(),
});

export const executorInputSchema = z.looseObject({
  type: z.string().max(64).optional(), // recommended: one of EXECUTOR_TYPES
  id: entityId.optional(),
  name: shortText.optional(),
  jobId: entityId.optional(),
  attempt: z.number().int().min(0).max(65_535).optional(),
});

export const targetInputSchema = z.looseObject({
  type: z.string().min(1).max(64),
  id: entityId,
  name: shortText.optional(),
});

export const changeInputSchema = z.object({
  field: z.string().min(1).max(EVENT_LIMITS.changeField),
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
  occurredAt: z.union([z.string(), z.number(), rawNumber]).optional(), // ISO-8601 or epoch ms; defaults to receive time
  environment: z.string().max(64).optional(), // default "production"
  outcome: z.string().max(32).optional(), // recommended: one of OUTCOMES; default "success"
  severity: z.string().max(32).optional(), // recommended: one of SEVERITIES; default "info"
  description: z.string().max(EVENT_LIMITS.description).optional(),
  actor: actorInputSchema.optional(),
  impersonator: actorInputSchema.optional(),
  executor: executorInputSchema.optional(),
  tenant: z.looseObject({ id: entityId, name: shortText.optional() }).optional(),
  source: z.string().max(128).optional(), // external system that supplied the change, e.g. "channel-manager"
  targets: z.array(targetInputSchema).max(EVENT_LIMITS.targets).optional(),
  changes: z.array(changeInputSchema).max(EVENT_LIMITS.changes).optional(),
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

export const ingestRejectionCodeSchema = z.enum([
  'invalid_event',
  'invalid_event_id',
  'duplicate_id_conflict',
  'stored_event_unreadable',
  'unverified_after_parse_failure',
]);
/**
 * Stable codes of the cut warnings. `targets_truncated` and `changes_truncated` carry `sent` (how many the event had),
 * `indexed` (how many are searchable) and `limit`; `change_fields_truncated` carries `cut` (field names shortened) and
 * `limit` (code units kept). Warnings without a code (an adjusted occurredAt, a numeric id) carry only `reason`.
 */
export const INGEST_WARNING_CODES = ['targets_truncated', 'changes_truncated', 'change_fields_truncated'] as const;
const warningIndex = z.number().int().nonnegative().meta({ description: 'Position of the event in the request.' });
const warningReason = z.string().meta({ description: 'What was adjusted, in words. Never contains event data.' });
const count = z.number().int().nonnegative();
/** A cut of targets or changes: how many the event had, how many are indexed, and the limit. */
const listCutWarningSchema = z.strictObject({
  index: warningIndex,
  reason: warningReason,
  code: z.enum(['targets_truncated', 'changes_truncated']),
  sent: count.meta({ description: 'How many the event had.' }),
  indexed: count.meta({ description: 'How many are indexed (searchable).' }),
  limit: count.meta({ description: 'The most that one event indexes.' }),
});
/** Change field names that were cut: how many, and the code units kept. */
const fieldCutWarningSchema = z.strictObject({
  index: warningIndex,
  reason: warningReason,
  code: z.literal('change_fields_truncated'),
  cut: z.number().int().positive().meta({ description: 'How many change field names were shortened.' }),
  limit: count.meta({ description: 'The UTF-16 code units of a field name that are indexed.' }),
});
/** Any other adjustment (an unusable occurredAt stored at receive time, a numeric id): words only. */
const plainWarningSchema = z.strictObject({ index: warningIndex, reason: warningReason });
export const ingestWarningSchema = z.union([listCutWarningSchema, fieldCutWarningSchema, plainWarningSchema]);
export type IngestWarning = z.infer<typeof ingestWarningSchema>;
export const ingestResponseSchema = z.object({
  accepted: z.number().int(),
  ids: z.array(z.string()),
  /** Conflicts start with duplicate_id_conflict: followed by actionable guidance. Original content is kept. */
  rejected: z.array(z.object({ index: z.number().int(), reason: z.string(), code: ingestRejectionCodeSchema })),
  /**
   * Accepted events that were adjusted, e.g. an unusable occurredAt stored at receive time (original kept in attributes).
   * A cut of targets, changes or change field names adds one entry per cut, with a stable `code` and counts only.
   */
  warnings: z.array(ingestWarningSchema).default([]),
});
export type IngestResponse = z.infer<typeof ingestResponseSchema>;
/** Request header a client sends to declare it resends only unsettled events (`Logbird-Retry: subset`). */
export const LOGBIRD_RETRY_HEADER = 'Logbird-Retry';
export const LOGBIRD_RETRY_SUBSET = 'subset';
/**
 * 503 ingest_pending / ingest_unavailable: siblings commit first; every index outside indices is settled.
 * Clients declaring Logbird-Retry: subset retry only unsettled events, byte-identically, with Retry-After.
 * Other clients get terminal 202 unverified_after_parse_failure rejections for rows a limit left unchecked after a
 * proven parse failure (rows deferred before any statement ran stay retryable for everyone),
 * unless other rows still need a retry (including held claims): unchecked rows then stay unresolved in 503.
 * Identical retries skip confirmed rows and reach terminal 202 once genuine pending writes resolve.
 */
export const ingestPendingDetailsSchema = ingestResponseSchema.extend({
  indices: z.array(z.number().int().nonnegative()),
  eventIds: z.array(z.string()),
});

export const changeValueKindSchema = z.enum(['absent', 'null', 'string', 'number', 'boolean', 'json']);
export type ChangeValueKind = z.infer<typeof changeValueKindSchema>;

const changeText = z
  .string()
  .describe(
    'Existing indexed text. Absent: empty string. Null: "null". String: its contents, without JSON quotes. Number: JSON number text that preserves numeric precision. Equivalent spellings may normalize (for example, 19.90 to 19.9 or 1e3 to 1000). Boolean: "true" or "false". JSON: compact JSON text for an object or array. Unpaired UTF-16 surrogates in indexed text are replaced with U+FFFD.',
  );
const changeKind = changeValueKindSchema
  .describe(
    'Original JSON kind for the corresponding value. Absent means the sender omitted that side. Optional: omitted when the kind is unknown, as on events stored before 0.4.0 (or by an older server during the upgrade), which therefore cannot tell null from the text "null".',
  )
  .optional();

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
  changes: z.array(z.object({ field: z.string(), before: changeText, after: changeText, beforeKind: changeKind, afterKind: changeKind })),
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
  payload: z.unknown(), // stored original JSON: same values and exact number digits; formatting not preserved
  parents: z.array(eventSchema), // causation chain root -> direct parent
  childCount: z.number().int(),
  operationSize: z.number().int(), // events sharing context.operationId
});
export type EventDetail = z.infer<typeof eventDetailSchema>;
