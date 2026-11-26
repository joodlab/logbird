import type { EventInput } from './index';

export interface LogbirdWarning {
  code: 'party_id_normalization';
  field: 'actor.id' | 'impersonator.id' | 'executor.id' | 'tenant.id' | 'targets' | `targets[${number}].id` | `targets[${number}].type`;
}

function needsWarning(value: unknown, limit: number): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed !== value || trimmed.length > limit || /[\uD800-\uDFFF]/u.test(value);
}

export function* partyWarnings(event: EventInput): Generator<LogbirdWarning> {
  const parties = ['actor', 'impersonator', 'executor', 'tenant'] as const;
  for (const party of parties) {
    if (needsWarning(event[party]?.id, 256)) yield { code: 'party_id_normalization', field: `${party}.id` };
  }
  if (!Array.isArray(event.targets)) return;
  for (const [index, target] of event.targets.entries()) {
    if (needsWarning(target?.id, 256)) yield { code: 'party_id_normalization', field: `targets[${index}].id` };
    if (needsWarning(target?.type, 64)) yield { code: 'party_id_normalization', field: `targets[${index}].type` };
  }
  if (event.targets.length > 64) yield { code: 'party_id_normalization', field: 'targets' };
}
