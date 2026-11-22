import { type EntityKind, formatRecordTerm } from '@logbird/contracts';
import { Bot, Building2, Cog, type LucideIcon, Package, User } from 'lucide-react';
import { formatTerm } from './query-language';

/**
 * URL segment ↔ entity kind. The `/workers` URL is kept for compatibility, but the UI calls every executor
 * (API server, queue worker, scheduler, webhook…) an "Executor". `field` is the envelope key that fills the section.
 */
export const ENTITY_SECTIONS = {
  actors: {
    kind: 'actor',
    label: 'Actors',
    singular: 'Actor',
    icon: User,
    field: 'actor',
    blurb: 'Who caused each action: people, API keys, integrations and the scheduler.',
  },
  tenants: {
    kind: 'tenant',
    label: 'Tenants',
    singular: 'Tenant',
    icon: Building2,
    field: 'tenant',
    blurb: 'Which customer or account each action happened in.',
  },
  workers: {
    kind: 'executor',
    label: 'Executors',
    singular: 'Executor',
    icon: Cog,
    field: 'executor',
    blurb: 'What performed each action: your API server, a queue worker or a cron job — with the attempt number.',
  },
  records: {
    kind: 'target',
    label: 'Records',
    singular: 'Record',
    icon: Package,
    field: 'targets',
    blurb: 'What was changed: bookings, rooms, users — any record your events target.',
  },
} as const satisfies Record<string, { kind: EntityKind; label: string; singular: string; icon: LucideIcon; field: string; blurb: string }>;

export type EntitySection = keyof typeof ENTITY_SECTIONS;

export function sectionForKind(kind: EntityKind): EntitySection {
  switch (kind) {
    case 'actor':
      return 'actors';
    case 'tenant':
      return 'tenants';
    case 'executor':
      return 'workers';
    default:
      return 'records';
  }
}

/** Query that selects every event involving the entity. Target ids are "<type>:<id>". */
export function entityQuery(kind: EntityKind, id: string, targetType?: string): string {
  if (kind === 'target' && id.includes(':')) {
    const pair = splitTargetId(id, targetType);
    return formatRecordTerm(pair.type, pair.id);
  }
  return formatTerm(kind, id);
}

/**
 * How well an entity matches what was typed, best first, the same order the server ranks a search by: 0 exact id,
 * 1 id prefix, 2 name prefix, 3 id or name contains it, 4 a fuzzy match only. A record's bare id (`article_27_2` for
 * `article:article_27_2`) counts as its id.
 */
export function entityMatchRank(entity: { id: string; name: string }, text: string): 0 | 1 | 2 | 3 | 4 {
  const t = text.trim().toLowerCase();
  const id = entity.id.toLowerCase();
  const bare = id.slice(id.indexOf(':') + 1);
  const name = entity.name.toLowerCase();
  if (!t) return 4;
  if (id === t || bare === t) return 0;
  if (id.startsWith(t) || bare.startsWith(t)) return 1;
  if (name.startsWith(t)) return 2;
  if (`${id} ${name}`.includes(t)) return 3;
  return 4;
}

/** Free text that could be an id: one word, no field, operator, quote, group or wildcard. */
export function looksLikeId(text: string): boolean {
  const t = text.trim();
  return t.length >= 2 && /^[^\s:()"'*-][^\s:()"'*]*$/.test(t) && !/^(AND|OR|NOT)$/.test(t);
}

export function targetEntityId(type: string, id: string): string {
  return `${type}:${id}`;
}

export function splitTargetId(entityId: string, type?: string): { type: string; id: string } {
  if (type !== undefined && entityId.startsWith(`${type}:`)) return { type, id: entityId.slice(type.length + 1) };
  const sep = entityId.indexOf(':');
  return sep >= 0 ? { type: entityId.slice(0, sep), id: entityId.slice(sep + 1) } : { type: '', id: entityId };
}

/** Icon for an actor/executor *type*. */
export function typeIcon(kind: EntityKind, type: string): LucideIcon {
  if (kind === 'actor') return type === 'user' || type === 'anonymous' ? User : Bot;
  if (kind === 'executor') return Cog;
  if (kind === 'tenant') return Building2;
  return Package;
}
