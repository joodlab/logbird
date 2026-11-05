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

/** Words that read better upper-cased inside a sentence ("API key", not "api key"). */
const ACRONYMS: Record<string, string> = { api: 'API', id: 'ID', ip: 'IP', sso: 'SSO', url: 'URL', otp: 'OTP', sdk: 'SDK', csv: 'CSV' };

/** "api_key" → "API key", "invite_link" → "invite link", "project.sample_data" → "project sample data". */
export function humanizeNoun(value: string): string {
  return value
    .split(/[._\s]+/)
    .filter(Boolean)
    .map((word) => ACRONYMS[word.toLowerCase()] ?? word)
    .join(' ');
}

/** Who to credit: a person's name, else their email (people who joined by link may have no name yet), else the id. */
export function personLabel(p: { name?: string; email?: string; id?: string } | null | undefined): string {
  return p?.name?.trim() || p?.email?.trim() || p?.id || '';
}

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
  const who = (performedByMachine ? e.executor?.name || e.executor?.id : '') || personLabel(e.actor) || e.executor?.name || e.executor?.id || '';
  const parts = e.action.split('.');
  const verb = parts.at(-1) ?? e.action;
  const noun = parts.slice(0, -1).join('.');
  const target = e.targets[0];
  // Nobody to credit: the action itself is the most honest summary ("validator.key.check").
  if (!who) return target?.name ? `${e.action} · ${target.name}` : e.action;
  if (INTRANSITIVE.has(verb)) return `${who} ${verb.replaceAll('_', ' ')}`;
  const verbText = VERB_PAST[verb] ?? verb.replaceAll('_', ' ');
  // "joined via link" with the joiner as the target: the object would only repeat the subject.
  if (target && e.actor && target.id === e.actor.id && target.type === (e.actor.type || 'user')) return `${who} ${verbText}`;
  // A named target of the action's own kind reads "API key ‘Production’"; another kind just by its name
  // ("updated Hotel Sunrise" for hotel.policy.updated). An opaque id reads worse than the action's own noun.
  const ownKind = target && noun && target.type.replaceAll('_', '.') === noun.replaceAll('_', '.');
  const object = target?.name
    ? ownKind
      ? `${humanizeNoun(noun)} ‘${target.name}’`
      : target.name
    : noun
      ? humanizeNoun(noun)
      : target
        ? `${humanizeNoun(target.type)} ${target.id}`
        : '';
  return `${who} ${verbText} ${object}`.trim();
}

export function actorLabel(e: AuditEvent): string {
  return personLabel(e.actor) || 'No actor';
}

/** Split "hotel.policy.updated" into dim namespace + strong verb for display. */
export function splitAction(action: string): { namespace: string; verb: string } {
  const i = action.lastIndexOf('.');
  if (i < 0) return { namespace: '', verb: action };
  return { namespace: action.slice(0, i + 1), verb: action.slice(i + 1) };
}

export const OUTCOME_ORDER = ['success', 'partial', 'denied', 'failure', 'unknown'] as const;
