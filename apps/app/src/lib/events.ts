import type { AuditEvent } from '@trailmark/contracts';

const VERB_PAST: Record<string, string> = {
  created: 'created',
  updated: 'updated',
  deleted: 'deleted',
  removed: 'removed',
  published: 'published',
  invited: 'invited',
  revoked: 'revoked',
  failed: 'failed',
  completed: 'completed',
  started: 'started',
  sent: 'sent',
};

const INTRANSITIVE = new Set(['signed_in', 'signed_out', 'logged_in', 'logged_out', 'signed_up']);

/**
 * The human sentence for an event. Prefer the producer's `description`; otherwise build
 * "<actor> <verb> <target>" from the envelope so even off-standard events read naturally.
 */
export function eventSentence(e: AuditEvent): string {
  // Some producers repeat the action as the description ("project.deleted"): build a sentence instead.
  if (e.description && e.description !== e.action) return e.description;
  // Work done by a worker/scheduler/webhook reads best credited to the executor ("CRM worker upserted …");
  // the actor who caused it stays visible in the actor column and the detail panel.
  const performedByMachine = e.executor && ['worker', 'scheduler', 'webhook', 'job'].includes(e.executor.type);
  const who = (performedByMachine ? e.executor?.name || e.executor?.id : '') || e.actor?.name || e.actor?.id || e.executor?.name || 'Something';
  const parts = e.action.split('.');
  const verb = parts.at(-1) ?? e.action;
  const noun = parts.slice(0, -1).join(' ');
  if (INTRANSITIVE.has(verb)) return `${who} ${verb.replaceAll('_', ' ')}`;
  const target = e.targets[0];
  // Prefer a name; an opaque id reads worse than the action's own noun ("changed project retention").
  const object = target?.name || noun || (target ? `${target.type} ${target.id}` : '');
  return `${who} ${VERB_PAST[verb] ?? verb.replaceAll('_', ' ')} ${object}`.trim();
}

export function actorLabel(e: AuditEvent): string {
  return e.actor?.name || e.actor?.id || 'No actor';
}

/** Split "hotel.policy.updated" into dim namespace + strong verb for display. */
export function splitAction(action: string): { namespace: string; verb: string } {
  const i = action.lastIndexOf('.');
  if (i < 0) return { namespace: '', verb: action };
  return { namespace: action.slice(0, i + 1), verb: action.slice(i + 1) };
}

export const OUTCOME_ORDER = ['success', 'partial', 'denied', 'failure', 'unknown'] as const;
