import { createHash } from 'node:crypto';
import type { ReadScope } from '@logbird/contracts';

/**
 * A read scope (#138) as a mandatory SQL predicate. Callers AND it OUTSIDE the compiled user filter, so nothing in `q`
 * (OR, negation, `tenant:*`) can widen it. Values are always bound parameters; parameter names use the `scope_`
 * prefix, which the query compiler never produces (it binds `q<n>`).
 * - tenant: `tenant_id` equals `tenantId` (never empty, so tenant-less events are invisible).
 * - target: ONE target has exactly this type and id (#169: same position, not type and id on different targets).
 * - actionPrefixes: the action starts with one of them.
 *
 * A scope names STORED ids (maintainer decision, #180). Ingest trims ids, repairs invalid Unicode (U+FFFD) and caps
 * them (256 code units; 64 for target types, 200 for actions). Scope ids are validated to be in stored form (no
 * surrounding whitespace, no U+FFFD or lone surrogates, at most 250 / 60 / 190 code units), so a capped or repaired
 * stored value can never equal a valid scope id. The only remaining way two different sent ids share a stored id is
 * surrounding whitespace in the original; Logbird treats those as one tenant everywhere (console pages, filters,
 * exports), and a scope sees exactly what the console shows for that stored id. See docs/security.md.
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

/** The binding stored in search cursors: the scope fingerprint, or for unscoped readers a project-only fingerprint. */
export function cursorBinding(projectId: string, scope?: ReadScope | null) {
  return (
    scopeFingerprint(scope, projectId) ??
    `u.${createHash('sha256')
      .update(JSON.stringify([projectId]))
      .digest('base64url')
      .slice(0, 16)}`
  );
}

/** A malformed cursor, or one minted under a different project or scope (HTTP 422 `validation_error`). */
export class CursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'CursorError';
  }
}
