import { createHmac, hkdfSync } from 'node:crypto';
import type { AuditEvent, ReadScope } from '@logbird/contracts';
import { facetColumn } from './queries';
import { compileQuery, QueryError } from './query';
import { MASKED_ATTRIBUTES, MASKED_COLUMNS } from './scope';

type Masks = ReadScope['mask'];

export const fieldMaskKey = (authSecret: string) => Buffer.from(hkdfSync('sha256', authSecret, '', 'logbird-field-mask-v1', 32));

/** A stable per-project pseudonym, so scoped readers can still group by person. */
export function maskedEmail(projectId: string, email: string, secret: Buffer) {
  return email ? `masked:${createHmac('sha256', secret).update(`${projectId}\0${email.toLowerCase()}`).digest('hex').slice(0, 24)}` : '';
}

export function maskEvent(event: AuditEvent, mask: Masks, secret?: Buffer): AuditEvent {
  if (!mask?.length) return event;
  const masked: AuditEvent = { ...event, context: { ...event.context }, attributes: { ...event.attributes } };
  if (mask.includes('ip')) masked.context.ip = '';
  if (mask.includes('user_agent')) masked.context.userAgent = '';
  if (mask.includes('actor_email')) {
    if (!secret) throw new Error('The actor_email mask requires a field mask key.');
    if (masked.actor) masked.actor = { ...masked.actor, email: maskedEmail(event.projectId, masked.actor.email, secret) };
  }
  for (const preset of mask) for (const key of MASKED_ATTRIBUTES[preset]) delete masked.attributes[key];
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
export function compileMaskedQuery(q: string, mask: Masks, clock?: number) {
  const compiled = compileQuery(q, clock);
  if (!mask?.length) return compiled;
  if (mask.some((preset) => new RegExp(`\\b${MASKED_COLUMNS[preset]}\\b`).test(compiled.sql))) maskedFieldError(0, q.length);
  const hiddenPaths = mask.flatMap((preset) => MASKED_ATTRIBUTES[preset]);
  for (const [, key] of compiled.sql.matchAll(/(?:attributes\[|mapContains\(attributes,)\{(q\d+):String\}/g))
    if (key && hiddenPaths.includes(String(compiled.params[key]))) maskedFieldError(0, q.length);
  return compiled;
}

export function assertNotMasked(scope: Pick<ReadScope, 'mask'> | null, input: { q?: string; field?: string; by?: string }) {
  if (!scope?.mask?.length) return;
  if (input.q) compileMaskedQuery(input.q, scope.mask);
  const hidden = scope.mask.map((preset) => MASKED_COLUMNS[preset]);
  const hiddenPaths = scope.mask.flatMap((preset) => MASKED_ATTRIBUTES[preset]);
  for (const field of [input.field, input.by]) {
    if (!field) continue;
    const column = facetColumn(field);
    if (column && hidden.includes(column)) maskedFieldError(null, null);
    if (!column && hiddenPaths.includes(field.replace(/^(attr|attributes)\./, ''))) maskedFieldError(null, null);
  }
}
