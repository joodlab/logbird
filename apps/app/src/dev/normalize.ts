import type { AuditEvent } from '@trailmark/contracts';

/** What an SDK would send (the recommended envelope plus anything else). */
export interface EventDraftBase {
  id: string;
  action: string;
  occurredAt: string;
  environment?: string;
  outcome?: string;
  severity?: string;
  description?: string;
  actor?: { type?: string; id?: string; name?: string; email?: string };
  impersonator?: { id?: string; name?: string };
  executor?: { type?: string; id?: string; name?: string; jobId?: string; attempt?: number };
  tenant?: { id: string; name?: string };
  source?: string;
  targets?: { type: string; id: string; name?: string }[];
  changes?: { field: string; before?: unknown; after?: unknown }[];
  context?: { operationId?: string; parentEventId?: string; requestId?: string; traceId?: string; ip?: string; userAgent?: string };
  metadata?: Record<string, unknown>;
  schemaVersion?: string;
}

/** Any extra top-level keys are allowed ("accept anything") and end up in attributes. */
export type EventDraft = EventDraftBase & Record<string, unknown>;

export interface StoredEvent {
  event: AuditEvent;
  payload: unknown;
}

const KNOWN = new Set([
  'id',
  'action',
  'occurredAt',
  'environment',
  'outcome',
  'severity',
  'description',
  'actor',
  'impersonator',
  'executor',
  'tenant',
  'source',
  'targets',
  'changes',
  'context',
  'metadata',
  'schemaVersion',
]);

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function flatten(prefix: string, value: unknown, out: Record<string, string>, depth = 0): void {
  if (Object.keys(out).length >= 256) return;
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && depth < 6) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(prefix ? `${prefix}.${k}` : k, v, out, depth + 1);
    return;
  }
  out[prefix] = stringify(value).slice(0, 2048);
}

/** Mirrors the server's normalization rules (SPEC §3) closely enough for a believable console. */
export function normalize(draft: EventDraft, projectId: string, receivedDelayMs: number, sdk = '@trailmark/sdk@0.1.0'): StoredEvent {
  const attributes: Record<string, string> = {};
  if (draft.metadata) flatten('metadata', draft.metadata, attributes);
  for (const [k, v] of Object.entries(draft)) {
    if (!KNOWN.has(k) && v !== undefined) flatten(k, v, attributes);
  }

  const checks = [
    Boolean(draft.occurredAt),
    Boolean(draft.actor?.id),
    Boolean(draft.actor?.type),
    Boolean(draft.outcome),
    (draft.targets?.length ?? 0) > 0,
    Boolean(draft.tenant?.id),
    Boolean(draft.executor?.type),
    Boolean(draft.context?.operationId || draft.context?.requestId),
    Boolean(draft.description),
  ];
  const conformance = Math.round((checks.filter(Boolean).length / checks.length) * 100);

  const timestamp = draft.occurredAt;
  const event: AuditEvent = {
    id: draft.id,
    projectId,
    timestamp,
    receivedAt: new Date(Date.parse(timestamp) + receivedDelayMs).toISOString(),
    environment: draft.environment ?? 'production',
    action: draft.action,
    category: draft.action.split('.')[0] ?? draft.action,
    outcome: draft.outcome ?? 'success',
    severity: draft.severity ?? 'info',
    description: draft.description ?? '',
    actor: draft.actor?.id
      ? { type: draft.actor.type ?? '', id: draft.actor.id, name: draft.actor.name ?? '', email: draft.actor.email ?? '' }
      : null,
    impersonator: draft.impersonator?.id ? { id: draft.impersonator.id, name: draft.impersonator.name ?? '' } : null,
    executor: draft.executor
      ? {
          type: draft.executor.type ?? '',
          id: draft.executor.id ?? '',
          name: draft.executor.name ?? '',
          jobId: draft.executor.jobId ?? '',
          attempt: draft.executor.attempt ?? 0,
        }
      : null,
    tenant: draft.tenant ? { id: draft.tenant.id, name: draft.tenant.name ?? '' } : null,
    source: draft.source ?? null,
    targets: (draft.targets ?? []).map((t) => ({ type: t.type, id: t.id, name: t.name ?? '' })),
    changes: (draft.changes ?? []).map((c) => ({ field: c.field, before: stringify(c.before), after: stringify(c.after) })),
    context: {
      operationId: draft.context?.operationId ?? '',
      parentEventId: draft.context?.parentEventId ?? '',
      requestId: draft.context?.requestId ?? '',
      traceId: draft.context?.traceId ?? '',
      ip: draft.context?.ip ?? '',
      userAgent: draft.context?.userAgent ?? '',
    },
    attributes,
    conformance,
    schemaVersion: draft.schemaVersion ?? '',
    sdk,
  };

  // The raw document exactly as "received": drop undefined keys like JSON.stringify would.
  const payload = JSON.parse(JSON.stringify(draft)) as unknown;
  return { event, payload };
}
