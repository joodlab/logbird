import type { EntityKind } from '@trailmark/contracts';
import { Bot, Building2, Cog, type LucideIcon, Package, User } from 'lucide-react';

/** URL segment ↔ entity kind. "Workers" covers every executor (workers, schedulers, webhooks, api). */
export const ENTITY_SECTIONS = {
  actors: { kind: 'actor', label: 'Actors', singular: 'Actor', icon: User, blurb: 'People, API keys, integrations and systems that cause events.' },
  tenants: { kind: 'tenant', label: 'Tenants', singular: 'Tenant', icon: Building2, blurb: 'Customer accounts and workspaces in your product.' },
  workers: {
    kind: 'executor',
    label: 'Workers',
    singular: 'Executor',
    icon: Cog,
    blurb: 'APIs, workers, schedulers and webhooks that performed the work.',
  },
  records: { kind: 'target', label: 'Records', singular: 'Record', icon: Package, blurb: 'Hotels, bookings, pages — the records events changed.' },
} as const satisfies Record<string, { kind: EntityKind; label: string; singular: string; icon: LucideIcon; blurb: string }>;

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
