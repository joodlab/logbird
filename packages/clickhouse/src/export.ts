import { type AuditEvent, EXPORT_SCHEMA_VERSION } from '@logbird/contracts';

// Stable order. Structured cells are JSON; every normalized event field is represented.
export const CSV_COLUMNS = [
  'id',
  'timestamp',
  'action',
  'outcome',
  'description',
  'project_id',
  'received_at',
  'environment',
  'category',
  'severity',
  'actor_type',
  'actor_id',
  'actor_name',
  'actor_email',
  'impersonator_id',
  'impersonator_name',
  'executor_type',
  'executor_id',
  'executor_name',
  'job_id',
  'job_attempt',
  'tenant_id',
  'tenant_name',
  'source',
  'targets',
  'changes',
  'context',
  'attributes',
  'conformance',
  'schema_version',
  'sdk',
  'schemaVersion',
] as const;

/** Quoting protects CSV syntax; the apostrophe separately prevents spreadsheet formula evaluation. */
export function csvCell(value: string | number) {
  const text = String(value);
  const dangerous = /^[\s\p{Cc}\p{Cf}]*[=+\-@＝＋－＠]/u.test(text) || /^[\s\p{Cc}\p{Cf}]*[\t\r\n]/u.test(text);
  const safe = dangerous ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function csvEvent(e: AuditEvent) {
  return `${[
    e.id,
    e.timestamp,
    e.action,
    e.outcome,
    e.description,
    e.projectId,
    e.receivedAt,
    e.environment,
    e.category,
    e.severity,
    e.actor?.type ?? '',
    e.actor?.id ?? '',
    e.actor?.name ?? '',
    e.actor?.email ?? '',
    e.impersonator?.id ?? '',
    e.impersonator?.name ?? '',
    e.executor?.type ?? '',
    e.executor?.id ?? '',
    e.executor?.name ?? '',
    e.executor?.jobId ?? '',
    e.executor?.attempt ?? '',
    e.tenant?.id ?? '',
    e.tenant?.name ?? '',
    e.source ?? '',
    JSON.stringify(e.targets),
    JSON.stringify(e.changes),
    JSON.stringify(e.context),
    JSON.stringify(e.attributes),
    e.conformance,
    e.schemaVersion,
    e.sdk,
    EXPORT_SCHEMA_VERSION,
  ]
    .map(csvCell)
    .join(',')}\n`;
}
