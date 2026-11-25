import { hkdfSync } from 'node:crypto';
import type { AuditEvent, ReadScope } from '@logbird/contracts';
import {
  ACTOR_NAME_MASK_PARAMS,
  actorNameIsSensitive,
  actorNamePseudonymInput,
  IMPERSONATOR_EMAIL_ATTRIBUTE,
  maskActorNameInFilter,
  maskedEmail,
} from './actor-name-mask';
import { facetColumn } from './queries';
import { type CompileOptions, compileQuery, QueryError } from './query';
import { MASKED_COLUMNS, maskedAttribute, pseudonymizedAttribute, removedAttribute } from './scope';

type Masks = ReadScope['mask'];

export const fieldMaskKey = (authSecret: string) => Buffer.from(hkdfSync('sha256', authSecret, '', 'logbird-field-mask-v1', 32));

export { maskedEmail } from './actor-name-mask';

export function maskEvent(event: AuditEvent, mask: Masks, secret?: Buffer): AuditEvent {
  if (!mask?.length) return event;
  const masked: AuditEvent = { ...event, context: { ...event.context }, attributes: { ...event.attributes } };
  if (mask.includes('ip')) masked.context.ip = '';
  if (mask.includes('user_agent')) masked.context.userAgent = '';
  if (mask.includes('actor_email')) {
    if (!secret) throw new Error('The actor_email mask requires a field mask key.');
    if (masked.actor) {
      const { email, name } = masked.actor;
      const hidden = maskedEmail(event.projectId, email, secret);
      // A producer that used the address as the display name too: the name would show what the mask hides. Same value,
      // and the same rule facets and filters apply in SQL (actor-name-mask.ts).
      const sensitive = actorNameIsSensitive(name, email);
      masked.actor = {
        ...masked.actor,
        email: hidden,
        name: sensitive ? maskedEmail(event.projectId, actorNamePseudonymInput(name, email), secret) : name,
      };
    }
    // The impersonator (support acting as the actor): the same rule for their name, judged against their email, which
    // ingest keeps as an attribute. Read before the attributes below are pseudonymized. Their pseudonyms are keyed by
    // role, so they never equal an actor's (maskedEmail).
    if (masked.impersonator) {
      const email = event.attributes[IMPERSONATOR_EMAIL_ATTRIBUTE] ?? '';
      const { name } = masked.impersonator;
      if (actorNameIsSensitive(name, email))
        masked.impersonator = {
          ...masked.impersonator,
          name: maskedEmail(event.projectId, actorNamePseudonymInput(name, email), secret, 'impersonator'),
        };
    }
    // The email shows as its pseudonym; paths below it are dropped whole, since their keys are producer text.
    for (const [key, value] of Object.entries(masked.attributes))
      if (pseudonymizedAttribute(mask, key)) masked.attributes[key] = maskedEmail(event.projectId, value, secret, 'impersonator');
  }
  // Masked attribute paths and everything below them go (below `impersonator.email` too: those keys are producer text).
  for (const key of Object.keys(masked.attributes)) if (removedAttribute(mask, key)) delete masked.attributes[key];
  return masked;
}

function maskedFieldError(start: number | null, end: number | null): never {
  throw new QueryError('This field is masked for this scope.', {
    lang: 'query',
    reason: 'not_allowed',
    start,
    end,
    hint: 'Remove filters and facets on masked fields',
  });
}

/** Guard the compiled columns and bound attribute keys so filtering cannot reveal masked values. */
export function compileMaskedQuery(q: string, mask: Masks, clock?: number, options?: CompileOptions) {
  const compiled = compileQuery(q, clock, options);
  if (!mask?.length) return compiled;
  if (mask.some((preset) => new RegExp(`\\b${MASKED_COLUMNS[preset]}\\b`).test(compiled.sql))) maskedFieldError(0, q.length);
  for (const [, key] of compiled.sql.matchAll(/(?:attributes\[|mapContains\(attributes,)\{(q\d+):String\}/g))
    if (key && maskedAttribute(mask, String(compiled.params[key]))) maskedFieldError(0, q.length);
  // After the checks above (the rewrite itself reads actor_email): a filter cannot select on a name that carries the
  // address, wherever it runs (webhook discovery and its send-time recheck compile here too) (#333).
  if (mask.includes('actor_email')) return { sql: maskActorNameInFilter(compiled.sql), params: { ...compiled.params, ...ACTOR_NAME_MASK_PARAMS } };
  return compiled;
}

export function assertNotMasked(scope: Pick<ReadScope, 'mask'> | null, input: { q?: string; field?: string; by?: string }) {
  if (!scope?.mask?.length) return;
  if (input.q) compileMaskedQuery(input.q, scope.mask);
  const hidden = scope.mask.map((preset) => MASKED_COLUMNS[preset]);
  for (const field of [input.field, input.by]) {
    if (!field) continue;
    const column = facetColumn(field);
    if (column && hidden.includes(column)) maskedFieldError(null, null);
    if (!column && maskedAttribute(scope.mask, field.replace(/^(attr|attributes)\./, ''))) maskedFieldError(null, null);
  }
}
