import { createHash } from 'node:crypto';
import type { ReadScope } from '@logbird/contracts';
import { pairedTargetSql } from './target-pair';

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
    parts.push(`(${pairedTargetSql('scope_target_type', 'scope_target_id')})`);
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
/**
 * Attribute paths a mask removes (an event may carry them as literal dotted keys), each with every path below it: a
 * literal key whose value is an object is flattened into child attributes (`"actor.name": {"en": ...}`).
 */
export const MASKED_ATTRIBUTES: Record<NonNullable<ReadScope['mask']>[number], string[]> = {
  ip: ['context.ip'],
  user_agent: ['context.userAgent'],
  // Literal dotted copies of the masked fields (a top-level `"impersonator.name": ...` key is stored as an attribute):
  // the name rule cannot judge them against their email, so they go, like `actor.email`.
  actor_email: ['actor.email', 'actor.name', 'impersonator.name'],
};
/**
 * Attribute paths a mask shows as a pseudonym instead of removing. Every path below one (`impersonator.email.work`, from
 * an email sent as an object) is removed instead: its key is producer text and can itself be an address. Filters and
 * facets on the path or below it are refused. Ingest keeps the impersonator's email, which the SDK input accepts, as
 * the attribute `impersonator.email`.
 */
export const PSEUDONYMIZED_ATTRIBUTES: Record<NonNullable<ReadScope['mask']>[number], string[]> = {
  ip: [],
  user_agent: [],
  actor_email: ['impersonator.email'],
};
/** Whether `mask` pseudonymizes attribute `key`. */
export const pseudonymizedAttribute = (mask: ReadScope['mask'], key: string) =>
  Boolean(mask?.some((preset) => PSEUDONYMIZED_ATTRIBUTES[preset].includes(key)));
/** Whether `mask` removes attribute `key` because it lies below a pseudonymized path. */
export const belowPseudonymizedAttribute = (mask: ReadScope['mask'], key: string) =>
  Boolean(mask?.some((preset) => PSEUDONYMIZED_ATTRIBUTES[preset].some((path) => key.startsWith(`${path}.`))));
const atOrBelow = (key: string, path: string) => key === path || key.startsWith(`${path}.`);
/** Whether `mask` removes attribute `key`: a masked path, a path below one, or a path below a pseudonymized one. */
export const removedAttribute = (mask: ReadScope['mask'], key: string) =>
  Boolean(mask?.some((preset) => MASKED_ATTRIBUTES[preset].some((path) => atOrBelow(key, path)))) || belowPseudonymizedAttribute(mask, key);
/** Whether `mask` hides attribute `key` (removed or pseudonymized), so a filter or facet on it would be an oracle. */
export const maskedAttribute = (mask: ReadScope['mask'], key: string) =>
  Boolean(mask?.some((preset) => MASKED_ATTRIBUTES[preset].some((path) => atOrBelow(key, path)))) ||
  pseudonymizedAttribute(mask, key) ||
  belowPseudonymizedAttribute(mask, key);

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
