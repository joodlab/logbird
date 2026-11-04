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

/**
 * The human sentence for an event. Prefer the producer's `description`; otherwise build
 * "<actor> <verb> <target>" from the envelope so even off-standard events read naturally.
 */
export function eventSentence(e: AuditEvent): string {
  if (e.description) return e.description;
  const who = e.actor?.name || e.actor?.id || e.executor?.name || 'Something';
  const parts = e.action.split('.');
  const verb = parts.at(-1) ?? e.action;
  const noun = parts.slice(0, -1).join(' ');
  const target = e.targets[0];
  const object = target ? target.name || `${target.type} ${target.id}` : noun;
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
