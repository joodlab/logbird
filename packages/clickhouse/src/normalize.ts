import { randomBytes } from 'node:crypto';
import { resolveTimestamp } from './timestamp';

function uuidv7() {
  const b = randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6);
  b[6] = ((b[6] ?? 0) & 15) | 112;
  b[8] = ((b[8] ?? 0) & 63) | 128;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const isHigh = (code: number) => code >= 0xd8_00 && code <= 0xdb_ff;
const isLow = (code: number) => code >= 0xdc_00 && code <= 0xdf_ff;
// A valid pair straddling a cap must not become a native JSONEachRow parse rejection.
const capText = (s: string, cap: number) => s.slice(0, isHigh(s.charCodeAt(cap - 1)) && isLow(s.charCodeAt(cap)) ? cap - 1 : cap);
// Search columns are lossy by design: a lone surrogate (which ClickHouse rejects as invalid UTF-8, code 25) becomes
// U+FFFD, like String.prototype.toWellFormed. The raw payload and v1 identity keep the original input.
const wellFormed = (s: string) => s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
const text = (v: unknown, cap = 512): string => (typeof v === 'string' ? capText(wellFormed(v.trim()), cap) : '');
const value = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? ''));
export function normalizeEvent(input: unknown, ctx: { projectId: string; receivedAt: Date; sdk?: string }) {
  // Search normalization is intentionally lossy. Identity v1 hashes canonical raw input, NOT these columns.
  // Changing caps/flattening must not change v1 or remove the legacy receipt compatibility path.
  const e = object(input);
  if (typeof e.action !== 'string') return { ok: false as const, reason: 'action must be a string' };
  if (typeof e.id === 'string' && (e.id.includes('\u0000') || /[\uD800-\uDFFF]/u.test(e.id) || e.id.trim().length > 256))
    return { ok: false as const, reason: 'invalid_event_id: id must be valid Unicode, at most 256 UTF-16 code units, and contain no NUL' };
  let payload: string;
  try {
    payload = JSON.stringify(input);
  } catch {
    return { ok: false as const, reason: 'event must be JSON serializable' };
  }
  if (Buffer.byteLength(payload) > 256 * 1024) return { ok: false as const, reason: 'event exceeds 256 KB' };
  const attributes: Record<string, string> = Object.create(null);
  let invalidAttributeKey = false;
  const flatten = (v: unknown, path: string, depth: number) => {
    if (Object.keys(attributes).length >= 256) return;
    // Reject instead of repairing keys: replacement could merge distinct attribute paths.
    if (/[\uD800-\uDFFF]/u.test(path)) {
      invalidAttributeKey = true;
      return;
    }
    const entries = Object.entries(object(v));
    if (entries.length && depth < 6) for (const [key, child] of entries) flatten(child, path ? `${path}.${key}` : key, depth + 1);
    else
      attributes[path] = Buffer.from(value(v))
        .subarray(0, 2048)
        .toString('utf8')
        .replace(/\uFFFD$/, '');
  };
  const known: Record<string, string[]> = {
    actor: ['type', 'id', 'name', 'email'],
    impersonator: ['id', 'name'],
    executor: ['type', 'id', 'name', 'jobId', 'attempt'],
    tenant: ['id', 'name'],
    context: ['operationId', 'parentEventId', 'requestId', 'traceId', 'ip', 'userAgent'],
  };
  const top = [
    'id',
    'action',
    'occurredAt',
    'environment',
    'outcome',
    'severity',
    'description',
    'source',
    'targets',
    'changes',
    'schemaVersion',
    ...Object.keys(known),
  ];
  for (const [key, v] of Object.entries(e)) if (!top.includes(key)) flatten(v, key, 1);
  for (const [key, fields] of Object.entries(known))
    for (const [k, v] of Object.entries(object(e[key]))) if (!fields.includes(k)) flatten(v, `${key}.${k}`, 2);
  const targets = Array.isArray(e.targets) ? e.targets.slice(0, 64).map(object) : [];
  targets.forEach((t, i) => {
    for (const [k, v] of Object.entries(t)) if (!['type', 'id', 'name'].includes(k)) flatten(v, `targets.${i}.${k}`, 3);
  });
  if (invalidAttributeKey) return { ok: false as const, reason: 'invalid_event: Attribute keys must be valid Unicode' };
  const changes = Array.isArray(e.changes) ? e.changes.slice(0, 256).map(object) : [];
  const actor = object(e.actor),
    executor = object(e.executor),
    tenant = object(e.tenant),
    context = object(e.context),
    imp = object(e.impersonator);
  // Only `action` is required: a bad occurredAt never drops the event. It is stored at receive time, the original value
  // is kept in attributes['logbird.occurredAt.rejected'] (and in payload), and the caller gets a warning.
  const { timestamp: date, problem: occurredAtProblem, valid: occurredAtValid } = resolveTimestamp(e.occurredAt, ctx.receivedAt);
  if (occurredAtProblem) attributes['logbird.occurredAt.rejected'] = capText(wellFormed(value(e.occurredAt)), 256);
  const warning =
    [
      occurredAtProblem ? `${occurredAtProblem}; stored at receive time` : null,
      typeof e.id === 'number' ? 'Numeric id is not a stable event id; send a string id for safe retries.' : null,
    ]
      .filter(Boolean)
      .join('; ') || null;
  const id = text(e.id, 256) || uuidv7();
  const row = {
    project_id: ctx.projectId,
    event_id: id,
    timestamp: date.toISOString(),
    received_at: ctx.receivedAt.toISOString(),
    action: text(e.action, 200),
    environment: text(e.environment, 64) || 'production',
    outcome: text(e.outcome, 32) || 'success',
    severity: text(e.severity, 32) || 'info',
    description: text(e.description, 4096),
    actor_type: text(actor.type, 64),
    actor_id: text(actor.id, 256),
    actor_name: text(actor.name),
    actor_email: text(actor.email),
    impersonator_id: text(imp.id, 256),
    impersonator_name: text(imp.name),
    executor_type: text(executor.type, 64),
    executor_id: text(executor.id, 256),
    executor_name: text(executor.name),
    job_id: text(executor.jobId, 256),
    job_attempt: typeof executor.attempt === 'number' ? Math.min(65_535, Math.max(0, Math.trunc(executor.attempt) || 0)) : 0,
    tenant_id: text(tenant.id, 256),
    tenant_name: text(tenant.name),
    source: text(e.source, 128),
    target_types: targets.map((t) => text(t.type, 64)),
    target_ids: targets.map((t) => text(t.id, 256)),
    target_names: targets.map((t) => text(t.name)),
    changes_fields: changes.map((c) => text(c.field, 256)),
    changes_before: changes.map((c) => wellFormed(value(c.before))),
    changes_after: changes.map((c) => wellFormed(value(c.after))),
    operation_id: text(context.operationId, 256),
    parent_event_id: text(context.parentEventId, 256),
    request_id: text(context.requestId, 256),
    trace_id: text(context.traceId, 256),
    ip: text(context.ip, 64),
    user_agent: text(context.userAgent, 1024),
    attributes,
    payload,
    conformance: Math.round(
      ([
        occurredAtValid,
        actor.id,
        actor.type,
        e.outcome,
        targets.length,
        tenant.id,
        executor.type,
        context.operationId || context.requestId,
        e.description,
      ].filter(Boolean).length /
        9) *
        100,
    ),
    schema_version: text(e.schemaVersion, 32),
    sdk: text(ctx.sdk, 128),
  };
  return { ok: true as const, row, id, warning };
}
export type EventRow = Extract<ReturnType<typeof normalizeEvent>, { ok: true }>['row'];
