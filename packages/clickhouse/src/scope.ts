import { createHash } from 'node:crypto';
import type { ReadScope } from '@logbird/contracts';

/**
 * A read scope (#138) as a mandatory SQL predicate. Callers AND it OUTSIDE the compiled user filter, so nothing in `q`
 * (OR, negation, `tenant:*`) can widen it. Values are always bound parameters; parameter names use the `scope_`
 * prefix, which the query compiler never produces (it binds `q<n>`).
 * - tenant: `tenant_id` must equal `tenantId` (never empty, so tenant-less events are invisible).
 * - target: some target has exactly this type and id (parallel arrays `target_types` / `target_ids`).
 * - actionPrefixes: the action starts with one of them.
 * Masks are not predicates; the server applies them to returned events.
 */
export function scopePredicate(scope: ReadScope | null | undefined): { sql: string; params: Record<string, string> } {
  if (!scope) return { sql: '1', params: {} };
  if (!scope.tenantId) throw new Error('A read scope requires a tenant');
  const parts = ['tenant_id = {scope_tenant:String}'];
  const params: Record<string, string> = { scope_tenant: scope.tenantId };
  if (scope.target) {
    parts.push('arrayExists((t, i) -> t = {scope_target_type:String} AND i = {scope_target_id:String}, target_types, target_ids)');
    params.scope_target_type = scope.target.type;
    params.scope_target_id = scope.target.id;
  }
  if (scope.actionPrefixes?.length) {
    parts.push(`(${scope.actionPrefixes.map((_, n) => `startsWith(action, {scope_action_${n}:String})`).join(' OR ')})`);
    for (const [n, prefix] of scope.actionPrefixes.entries()) params[`scope_action_${n}`] = prefix;
  }
  return { sql: parts.join(' AND '), params };
}

/** Columns a masked scope may neither return nor filter, facet or sort on (a filter would be an oracle). */
export const MASKED_COLUMNS: Record<NonNullable<ReadScope['mask']>[number], string> = {
  ip: 'ip',
  user_agent: 'user_agent',
  actor_email: 'actor_email',
};

/** Stable identity of a scope, used to bind cursors to the scope they were minted under. */
export function scopeFingerprint(scope: ReadScope | null | undefined) {
  if (!scope) return null;
  const canonical = JSON.stringify([
    scope.tenantId,
    scope.target ? [scope.target.type, scope.target.id] : null,
    [...(scope.actionPrefixes ?? [])].sort(),
    [...(scope.mask ?? [])].sort(),
  ]);
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 16);
}

/** A malformed cursor, or one minted under a different scope (HTTP 422 `validation_error`). */
export class CursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'CursorError';
  }
}
