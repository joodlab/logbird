// Frozen test fixture generated verbatim from 3a1541f632ce4be4c42b022a7da0d83fa6e7fbbd. Only exported symbol names differ.
import { createHash, randomBytes } from 'node:crypto';

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
const text = (v: unknown, cap = 512): string => (typeof v === 'string' ? v.trim().slice(0, cap) : '');
const value = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? ''));
export function normalizeEvent3a1541f(input: unknown, ctx: { projectId: string; receivedAt: Date; sdk?: string }) {
  const e = object(input);
  if (typeof e.action !== 'string') return { ok: false as const, reason: 'action must be a string' };
  let payload: string;
  try {
    payload = JSON.stringify(input);
  } catch {
    return { ok: false as const, reason: 'event must be JSON serializable' };
  }
  if (Buffer.byteLength(payload) > 256 * 1024) return { ok: false as const, reason: 'event exceeds 256 KB' };
  const attributes: Record<string, string> = Object.create(null);
  const flatten = (v: unknown, path: string, depth: number) => {
    if (Object.keys(attributes).length >= 256) return;
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
  const changes = Array.isArray(e.changes) ? e.changes.slice(0, 256).map(object) : [];
  const actor = object(e.actor),
    executor = object(e.executor),
    tenant = object(e.tenant),
    context = object(e.context),
    imp = object(e.impersonator);
  // Only `action` is required: a bad occurredAt never drops the event. It is stored at receive time, the original value
  // is kept in attributes['logbird.occurredAt.rejected'] (and in payload), and the caller gets a warning.
  const occurredAtProblem = (() => {
    if (e.occurredAt === undefined || e.occurredAt === null || e.occurredAt === '') return null;
    if (typeof e.occurredAt !== 'string' && typeof e.occurredAt !== 'number') return 'occurredAt must be ISO-8601 or epoch milliseconds';
    if (typeof e.occurredAt === 'number' && Math.abs(e.occurredAt) < 1e11)
      return 'occurredAt looks like epoch seconds; send milliseconds or ISO-8601';
    const t = new Date(e.occurredAt).getTime();
    if (!Number.isFinite(t)) return 'occurredAt is not a valid date';
    if (t < ctx.receivedAt.getTime() - 3650 * 86_400_000 || t > ctx.receivedAt.getTime() + 86_400_000)
      return 'occurredAt must be within the last 3650 days and the next 24 hours';
    return null;
  })();
  const occurredAtValid = e.occurredAt !== undefined && e.occurredAt !== null && e.occurredAt !== '' && !occurredAtProblem;
  const date = occurredAtValid ? new Date(e.occurredAt as string | number) : ctx.receivedAt;
  if (occurredAtProblem) attributes['logbird.occurredAt.rejected'] = value(e.occurredAt).slice(0, 256);
  const warning = occurredAtProblem ? `${occurredAtProblem}; stored at receive time` : null;
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
    changes_before: changes.map((c) => value(c.before)),
    changes_after: changes.map((c) => value(c.after)),
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
type EventRow = Extract<ReturnType<typeof normalizeEvent3a1541f>, { ok: true }>['row'];

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sorted(child)]),
    );
  return value;
}

/** Compare normalized content; JSON key order, raw formatting and transport SDK are not identity. */
export function legacyFingerprint3a1541f(row: EventRow) {
  const { received_at: _received, payload: _payload, sdk: _sdk, ...content } = row;
  return createHash('sha256')
    .update(JSON.stringify(sorted(content)))
    .digest('hex');
}
