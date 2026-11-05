import type { EntityKind } from '@trailmark/contracts';
import { Bot, Building2, Cog, type LucideIcon, Package, User } from 'lucide-react';

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
export function entityQuery(kind: EntityKind, id: string): string {
  if (kind === 'target') {
    const sep = id.indexOf(':');
    if (sep > 0) return `target:${quote(id.slice(sep + 1))} target.type:${quote(id.slice(0, sep))}`;
    return `target:${quote(id)}`;
  }
  return `${kind}:${quote(id)}`;
}

function quote(v: string): string {
  return /[\s()"]/.test(v) ? `"${v.replaceAll('"', '\\"')}"` : v;
}

export function targetEntityId(type: string, id: string): string {
  return `${type}:${id}`;
}

export function splitTargetId(entityId: string): { type: string; id: string } {
  const sep = entityId.indexOf(':');
  return sep > 0 ? { type: entityId.slice(0, sep), id: entityId.slice(sep + 1) } : { type: '', id: entityId };
}

/** Icon for an actor/executor *type*. */
export function typeIcon(kind: EntityKind, type: string): LucideIcon {
  if (kind === 'actor') return type === 'user' || type === 'anonymous' ? User : Bot;
  if (kind === 'executor') return Cog;
  if (kind === 'tenant') return Building2;
  return Package;
}
