import type { AuditEvent } from '@logbird/contracts';
import { formatTerm, hasTerm, includeTerm, removeTerm } from '@/lib/query-language';

/**
 * Support impersonation, in plain words. When `impersonator` is set, the actor is the customer it was done *as*
 * and the impersonator is the support agent who was at the keyboard. Every list, page and filter says so.
 */

/** The support agent's display name, falling back to the id. */
export function supportAgentName(e: Pick<AuditEvent, 'impersonator'>): string | null {
  return e.impersonator ? e.impersonator.name || e.impersonator.id : null;
}

/** Query for everything one support agent did while acting as customers. */
export function supportAgentQuery(agentId: string): string {
  return formatTerm('impersonator', agentId);
}

/** "Who did it" split for timelines: everything, only what support did, or only what the party did themselves. */
export type WhoFilter = 'all' | 'support' | 'self';

export const SUPPORT_TERM = 'impersonator:*';

export function whoFilter(q: string): WhoFilter {
  if (hasTerm(q, 'impersonator', '*', false)) return 'support';
  if (hasTerm(q, 'impersonator', '*', true)) return 'self';
  return 'all';
}

/** Swap the who-split in a query, keeping every other term. */
export function withWhoFilter(q: string, who: WhoFilter): string {
  const without = removeTerm(removeTerm(q, 'impersonator', '*', false), 'impersonator', '*', true);
  if (who === 'support') return includeTerm(without, 'impersonator', '*');
  if (who === 'self') return `${without} -${SUPPORT_TERM}`.trim();
  return without;
}

/**
 * Compact background-job hint for a list row: which executor ran it and which try this was. Only for events that
 * came from a job (a job id, or a retry), so interactive actions stay uncluttered.
 */
export function jobHint(e: Pick<AuditEvent, 'executor'>): { executor: string; attempt: number; jobId: string; label: string } | null {
  const x = e.executor;
  if (!x || !(x.jobId || x.attempt > 1)) return null;
  const executor = x.name || x.id || x.type || 'job';
  const attempt = x.attempt;
  const label = [`Background job${x.jobId ? ` ${x.jobId}` : ''}`, x.name || x.id ? `run by ${executor}` : null, attempt > 0 ? `try ${attempt}` : null]
    .filter(Boolean)
    .join(', ');
  return { executor, attempt, jobId: x.jobId, label };
}
