import { createHash } from 'node:crypto';
import type { ReadScope } from '@logbird/contracts';

/**
 * A read scope (#138) as a mandatory SQL predicate. Callers AND it OUTSIDE the compiled user filter, so nothing in `q`
 * (OR, negation, `tenant:*`) can widen it. Values are always bound parameters; parameter names use the `scope_`
 * prefix, which the query compiler never produces (it binds `q<n>`).
 * - tenant: the event's tenant id equals `tenantId` (never empty, so tenant-less events are invisible).
 * - target: ONE target has exactly this type and id (#169: same position, not type and id on different targets).
 * - actionPrefixes: the action starts with one of them.
 *
 * Every condition is checked twice: on the search columns (indexed and cheap, but normalized at ingest: trimmed,
 * Unicode-repaired, capped) and on the original stored payload, which is exact. The columns prune; the payload
 * decides, so two source identifiers that normalize to the same stored value never see each other's events.
 * Masks are not predicates; the server applies them to returned events.
 */
export function scopePredicate(scope: ReadScope | null | undefined): { sql: string; params: Record<string, string> } {
  if (!scope) return { sql: '1', params: {} };
  if (!scope.tenantId) throw new Error('A read scope requires a tenant');
  const parts = ['tenant_id = {scope_tenant:String}', "JSONExtractString(payload, 'tenant', 'id') = {scope_tenant:String}"];
  const params: Record<string, string> = { scope_tenant: scope.tenantId };
  if (scope.target) {
    parts.push(
      'arrayExists((t, i) -> t = {scope_target_type:String} AND i = {scope_target_id:String}, target_types, target_ids)',
      // Ingest keeps the first 64 targets; the original must carry the type and id on the same target object.
      "arrayExists(x -> JSONExtractString(x, 'type') = {scope_target_type:String} AND JSONExtractString(x, 'id') = {scope_target_id:String}, arraySlice(JSONExtractArrayRaw(payload, 'targets'), 1, 64))",
    );
    params.scope_target_type = scope.target.type;
    params.scope_target_id = scope.target.id;
  }
  if (scope.actionPrefixes?.length) {
    const prefixes = scope.actionPrefixes;
    const either = (expr: string) => prefixes.map((_, n) => `startsWith(${expr}, {scope_action_${n}:String})`).join(' OR ');
    parts.push(`(${either('action')})`, `(${either("JSONExtractString(payload, 'action')")})`);
    for (const [n, prefix] of prefixes.entries()) params[`scope_action_${n}`] = prefix;
  }
  return { sql: parts.join(' AND '), params };
}

/** Columns a masked scope may neither return nor filter or facet on (a filter would be an oracle). */
export const MASKED_COLUMNS: Record<NonNullable<ReadScope['mask']>[number], string> = {
  ip: 'ip',
  user_agent: 'user_agent',
  actor_email: 'actor_email',
};
/** Attribute paths a mask hides too (an event may carry them as literal dotted keys). */
export const MASKED_ATTRIBUTES: Record<NonNullable<ReadScope['mask']>[number], string[]> = {
  ip: ['context.ip'],
  user_agent: ['context.userAgent'],
  actor_email: ['actor.email'],
};

/** Stable identity of a scope within a project, used to bind cursors to the project and scope that minted them. */
export function scopeFingerprint(scope: ReadScope | null | undefined, projectId: string) {
  if (!scope) return null;
  const canonical = JSON.stringify([
    projectId,
    scope.tenantId,
    scope.target ? [scope.target.type, scope.target.id] : null,
    [...(scope.actionPrefixes ?? [])].sort(),
    [...(scope.mask ?? [])].sort(),
  ]);
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 16);
}

/** A malformed cursor, or one minted under a different project or scope (HTTP 422 `validation_error`). */
export class CursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'CursorError';
  }
}
