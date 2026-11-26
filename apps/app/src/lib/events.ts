import { type AuditEvent, supportsExactJson } from '@logbird/contracts';
import { changeValuePreview, REDACTED_CHANGE_VALUE } from './change-values';
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
/** Whether the sentence is the producer's own description rather than one built from the envelope. */
export const usesDescription = (e: Pick<AuditEvent, 'description' | 'action'>) => Boolean(e.description) && e.description !== e.action;

/**
 * Who a built sentence credits, and which party that is. Work done by a worker/scheduler/webhook reads best credited
 * to the executor ("CRM worker upserted …"); the actor who caused it stays visible in the actor column and the detail
 * panel. Callers compare parties, never display names: a worker and a user may both be called "Lina".
 */
export function sentenceSubject(e: AuditEvent): { who: string; party: 'actor' | 'executor' | null } {
  const machine = e.executor && ['worker', 'scheduler', 'webhook', 'job'].includes(e.executor.type);
  const executorLabel = e.executor?.name || e.executor?.id || '';
  if (machine && executorLabel) return { who: executorLabel, party: 'executor' };
  const actor = personLabel(e.actor);
  if (actor) return { who: actor, party: 'actor' };
  if (executorLabel) return { who: executorLabel, party: 'executor' };
  return { who: '', party: null };
}

export function eventSentence(e: AuditEvent): string {
  // Some producers repeat the action as the description ("project.deleted"): build a sentence instead.
  if (usesDescription(e)) return e.description;
  const { who, party } = sentenceSubject(e);
  const parts = e.action.split('.');
  const verb = parts.at(-1) ?? e.action;
  const noun = parts.slice(0, -1).join('.');
  const target = e.targets[0];
  // Nobody to credit: the action itself is the most honest summary ("validator.key.check").
  if (!who) return target?.name ? `${e.action} · ${target.name}` : e.action;
  if (INTRANSITIVE.has(verb)) return `${who} ${verb.replaceAll('_', ' ')}`;
  const verbText = VERB_PAST[verb] ?? verb.replaceAll('_', ' ');
  // "joined via link" with the joiner as the target: the object would only repeat the subject.
  // Only by id: an actor and a target both recorded without one are not the same party.
  // Only when the actor is also the sentence's subject: a worker updating the actor's own record keeps its object
  // ("Billing worker updated Lina's profile", not "Billing worker updated") (#333).
  const actorIsSubject = party === 'actor';
  if (actorIsSubject && target && e.actor?.id && target.id === e.actor.id && target.type === (e.actor.type || 'user')) return `${who} ${verbText}`;
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
    const fromChanges = changeSentence(e, target.name);
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

/** Field names as people say them. */
function fieldLabel(field: string): string {
  if (field === 'retentionDays') return 'retention';
  return humanizeNoun(field);
}

function joinWords(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function isWholeDayCount(text: string): boolean {
  const days = Number(text);
  return days >= 0 && Number.isSafeInteger(days) && String(days) === text;
}

/**
 * "changed ‹target›’s role from admin to member" for one recorded change; "changed ‹target›’s name and description"
 * for several. Null when there are no changes to describe.
 */
function changeSentence(event: AuditEvent, targetName: string): string | null {
  const list = (event.changes ?? []).filter((c) => c.field);
  if (list.length === 0) return null;
  const owner = possessive(targetName);
  if (list.length > 1) return `changed ${owner} ${joinWords([...new Set(list.map((c) => fieldLabel(c.field)))])}`;
  const [c] = list as [AuditEvent['changes'][number]];
  const label = fieldLabel(c.field);
  // The read API uses the server-assigned ws:<organizationId> project ID for workspace audit events.
  const workspaceActivity = event.projectId?.startsWith('ws:');
  const retention =
    workspaceActivity &&
    c.field === 'retentionDays' &&
    (c.beforeKind === undefined || c.beforeKind === 'number') &&
    (c.afterKind === undefined || c.afterKind === 'number') &&
    isWholeDayCount(c.before) &&
    isWholeDayCount(c.after);
  const inlineValue = (text: string, kind: typeof c.beforeKind) => {
    if (kind === 'absent' || (!kind && !text)) return '';
    if (workspaceActivity && c.field === 'role' && (kind === undefined || kind === 'string')) {
      const roles = text.split(',').map((token) => token.trim());
      if (roles.every((role) => Object.hasOwn(ROLE_LABEL, role))) return roles.map((role) => ROLE_LABEL[role]).join(', ');
    }
    if (retention) return formatRetention(Number(text));
    return changeValuePreview(text, kind);
  };
  const before = inlineValue(c.before, c.beforeKind);
  const after = inlineValue(c.after, c.afterKind);
  const showable = (v: string) => v.length <= MAX_INLINE_VALUE;
  if (c.before === REDACTED_CHANGE_VALUE || c.after === REDACTED_CHANGE_VALUE) return `changed ${owner} ${label}`;
  if (!(showable(before) && showable(after))) return `changed ${owner} ${label}`;
  if (before && after && before !== after) {
    const unit = retention && before.endsWith(' days') && after.endsWith(' days') ? ' days' : '';
    return `changed ${owner} ${label} from ${unit ? before.slice(0, -unit.length) : before} to ${after}`;
  }
  if (c.beforeKind === 'absent' && after) return `set ${owner} ${label} to ${after}`;
  if (c.afterKind === 'absent' && before) return `removed ${owner} ${label}`;
  return `changed ${owner} ${label}`;
}

/** Logbird's own management actions whose generic sentence would mislead ("loaded ‹project›"). */
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

/**
 * Whether the producer actually sent an `outcome`. ClickHouse stores a missing outcome as "success", so the detail
 * view checks the raw payload: `false` = not sent (show it neutrally, not as a green success), `null` = unknown
 * (payload not loaded or not an object).
 */
export function outcomeWasSent(payload: unknown): boolean | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const outcome = (payload as Record<string, unknown>).outcome;
  return typeof outcome === 'string' ? outcome.trim() !== '' : outcome !== undefined && outcome !== null;
}

/** Attribute keys (last dot segment) that producers commonly use to name who did something outside `actor`. */
const ACTOR_LIKE_KEY =
  /^(?:(?:performed|initiated|triggered|requested|started|created|updated|changed|done|run|executed)[_-]?by|(?:actor|user|operator)[_-]?name|username|operator)$/i;

/**
 * For events without an actor: an attribute that names who did it (`performed_by: "Hourly CRM bookings scheduler"`).
 * Shown as a hint, never as the actor — the producer did not say so in the envelope.
 */
export function actorAttributeHint(attributes: Record<string, string>): { key: string; value: string } | null {
  const candidates = Object.entries(attributes)
    .filter(([key, value]) => value.trim() && ACTOR_LIKE_KEY.test(key.split('.').at(-1) ?? key))
    .sort(([a], [b]) => a.split('.').length - b.split('.').length || a.localeCompare(b));
  const [key, value] = candidates[0] ?? [];
  return key && value ? { key, value: value.trim() } : null;
}

/** The nearest step in the causation chain (root → direct parent) that recorded an actor it can name (name, email or id). */
export function parentActor(parents: readonly Pick<AuditEvent, 'actor'>[]): NonNullable<AuditEvent['actor']> | null {
  for (let i = parents.length - 1; i >= 0; i--) {
    const actor = parents[i]?.actor;
    if (actor && personLabel(actor)) return actor;
  }
  return null;
}

/**
 * True when this browser cannot parse JSON numbers exactly (no JSON.parse source access): long numbers and decimals
 * in a raw payload may show and copy rounded. The stored event and the Complete export keep the exact digits.
 */
export const roundsLargeNumbers = !supportsExactJson;

/** Events directly caused by `eventId` (their `context.parentEventId`), oldest first. */
export function directChildren(events: readonly AuditEvent[], eventId: string): AuditEvent[] {
  // The operation endpoint returns one row per (timestamp, id): an id stored at two timestamps is still one child.
  const seen = new Set<string>();
  return events
    .filter((c) => c.context.parentEventId === eventId && c.id !== eventId)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id))
    .filter((c) => !seen.has(c.id) && Boolean(seen.add(c.id)));
}

/**
 * How many other events name this one as their parent. The server counts every stored event with
 * `parentEventId = id`, which includes the event itself when it (wrongly) names itself as its parent.
 */
export function causedCount(detail: { childCount: number }, e: Pick<AuditEvent, 'id' | 'context'>): number {
  return Math.max(0, detail.childCount - (e.context.parentEventId === e.id ? 1 : 0));
}

type Party = { id: string; type: string; name: string; email?: string };

/**
 * One party's identity, as a collision-free string (a JSON tuple, so no separator inside a type or name can make two
 * parties alike): its id when it has one, else everything it was recorded with. Used both to group parties and as their
 * React key.
 */
export function partyKey(p: Party): string {
  return p.id ? JSON.stringify(['id', p.id]) : JSON.stringify(['anon', p.type, p.name, p.email ?? '']);
}

/**
 * Who an operation's events name as a party (actors, or executors), each once, in the order first seen. A party with an
 * id is the same party wherever it appears and reads as its latest record (events come oldest first, so a name added
 * later wins); one recorded without an id is told apart by its type, name and email, so two different id-less parties
 * never collapse into one. Events that recorded nothing for the party add nothing.
 */
export function distinctParties<P extends Party>(parties: readonly (P | null | undefined)[]): P[] {
  const byKey = new Map<string, P>();
  for (const p of parties) {
    if (!p || !(p.id || p.type || p.name || p.email)) continue;
    // Map.set on an existing key keeps its position: the party stays where it first appeared.
    byKey.set(partyKey(p), p);
  }
  return [...byKey.values()];
}

/** A party recorded without an id has no profile to link to: its name, else its email, else empty (callers show the type). */
export function unlinkedPartyLabel(p: { name?: string; email?: string }): string {
  return p.name?.trim() || p.email?.trim() || '';
}
