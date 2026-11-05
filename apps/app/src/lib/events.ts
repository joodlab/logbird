import type { AuditEvent } from '@trailmark/contracts';
import { formatRetention } from './format';

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

/** "api_key" → "API key", "invite_link" → "invite link", "project.sample_data" → "project sample data", "retentionDays" → "retention days". */
export function humanizeNoun(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
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
 * Who created a key, view or link: name, else email. Empty when neither is known (callers then omit "by …"); never an
 * opaque user id.
 */
export function creatorLabel(creator: { name?: string | null; email?: string | null } | null | undefined): string {
  return creator?.name?.trim() || creator?.email?.trim() || '';
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
  const special = specialSentence(e, who, noun, verb);
  if (special) return special;
  // A named target of the action's own kind reads "API key ‘Production’" (also when the kind is the noun's last part:
  // "hotel.policy" + a policy target).
  const nounKey = noun.replaceAll('_', '.');
  const targetKey = target?.type.replaceAll('_', '.') ?? '';
  const ownKind = Boolean(target && noun && (targetKey === nounKey || nounKey.endsWith(`.${targetKey}`)));
  // "changed"/"updated" say *what* changed: from the recorded `changes` when there are any ("changed Hotel Sunrise’s
  // cancellation policy from flexible to strict"), else from the rest of the action ("member.role.changed" → "changed
  // ‹target›’s role").
  if (target?.name && CHANGE_VERBS.has(verb)) {
    const fromChanges = changeSentence(e.changes, target.name);
    if (fromChanges) return `${who} ${fromChanges}`;
    const attribute = ownKind ? '' : noun.split('.').slice(1).join('.');
    if (attribute) return `${who} ${verbText} ${possessive(target.name)} ${humanizeNoun(attribute)}`;
  }
  // Another kind reads just by its name ("approved Hotel Sunrise"). An opaque id reads worse than the action's own noun.
  const object = target?.name
    ? ownKind
      ? `${humanizeNoun(noun)} ‘${target.name}’`
      : target.name
    : noun
      ? withArticle(humanizeNoun(noun))
      : target
        ? `${humanizeNoun(target.type)} ${target.id}`
        : '';
  return `${who} ${verbText} ${object}`.trim();
}

const CHANGE_VERBS = new Set(['changed', 'updated']);
const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
/** Values longer than this read badly inline; the sentence then names the field only (the panel shows the diff). */
const MAX_INLINE_VALUE = 40;

/** "Hotel Sunrise" → "Hotel Sunrise’s", "Saffron Suites" → "Saffron Suites’". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}’` : `${name}’s`;
}

function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) && !/^(user|uni|eu)/i.test(noun) ? 'an' : 'a'} ${noun}`;
}

/** Field names as people say them; values formatted per field (roles by label, retention in days or years). */
function fieldLabel(field: string): string {
  if (field === 'retentionDays') return 'retention';
  return humanizeNoun(field);
}

function fieldValue(field: string, value: string): string {
  if (field === 'role')
    return value
      .split(',')
      .map((r) => ROLE_LABEL[r.trim()] ?? r.trim())
      .join(', ');
  if (field === 'retentionDays' && /^\d+$/.test(value)) return formatRetention(Number(value));
  return value;
}

function joinWords(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/**
 * "changed ‹target›’s role from Admin to Member" for one recorded change; "changed ‹target›’s name and description"
 * for several. Null when there are no changes to describe.
 */
export function changeSentence(changes: AuditEvent['changes'] | undefined, targetName: string): string | null {
  const list = (changes ?? []).filter((c) => c.field);
  if (list.length === 0) return null;
  const owner = possessive(targetName);
  if (list.length > 1) return `changed ${owner} ${joinWords([...new Set(list.map((c) => fieldLabel(c.field)))])}`;
  const [c] = list as [AuditEvent['changes'][number]];
  const label = fieldLabel(c.field);
  const before = c.before ? fieldValue(c.field, c.before) : '';
  const after = c.after ? fieldValue(c.field, c.after) : '';
  const showable = (v: string) => v.length <= MAX_INLINE_VALUE && v !== '[redacted]';
  if (!(showable(before) && showable(after))) return `changed ${owner} ${label}`;
  if (before && after) {
    // "from 90 to 180 days" rather than "from 90 days to 180 days".
    const unit = / days$/.exec(before)?.[0] && / days$/.test(after) ? ' days' : '';
    return `changed ${owner} ${label} from ${unit ? before.slice(0, -unit.length) : before} to ${after}`;
  }
  if (after) return `set ${owner} ${label} to ${after}`;
  if (before) return `cleared ${owner} ${label}`;
  return `changed ${owner} ${label}`;
}

/** Trailmark's own management actions whose generic sentence would mislead ("loaded ‹project›"). */
function specialSentence(e: AuditEvent, who: string, noun: string, verb: string): string | null {
  const target = e.targets[0];
  const name = target?.name;
  if (noun === 'project.sample_data' && name) {
    if (verb === 'loaded') return `${who} loaded sample data into ${name}`;
    if (verb === 'removed') return `${who} removed sample data from ${name}`;
  }
  if (e.action === 'project.retention.reviewed' && name) return `${who} reviewed retention for ${name}`;
  if (e.action === 'project.setup.dismissed' && name) {
    const restored = (e.changes ?? []).find((c) => c.field === 'setupDismissed')?.after === 'false';
    return `${who} ${restored ? 'restored' : 'dismissed'} the setup checklist for ${name}`;
  }
  // Invite links have no name of their own; the server labels the target with the link's role.
  if (target?.type === 'invite_link' && name && ROLE_LABEL[name]) {
    const verbText = VERB_PAST[verb] ?? verb.replaceAll('_', ' ');
    return `${who} ${verbText} ${withArticle(`${ROLE_LABEL[name].toLowerCase()} invite link`)}`;
  }
  return null;
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
