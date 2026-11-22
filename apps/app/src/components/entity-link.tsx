import type { EntityKind } from '@logbird/contracts';
import { EntityChip } from '@logbird/ui/components/entity-chip';
import { cn } from '@logbird/ui/lib/utils';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { sectionForKind, typeIcon } from '@/lib/entities';

/** Typed link to an entity profile (actors / tenants / workers / records). */
export function EntityProfileLink({
  projectId,
  kind,
  id,
  type,
  children,
  className,
}: {
  projectId: string;
  kind: EntityKind;
  id: string;
  type?: string;
  children: ReactNode;
  className?: string;
}) {
  if (kind === 'target') {
    return (
      <Link
        className={className}
        onClick={(e) => e.stopPropagation()}
        params={{ projectId, entityId: id }}
        search={{ targetType: type }}
        to="/p/$projectId/records/$entityId"
      >
        {children}
      </Link>
    );
  }
  const section = sectionForKind(kind);
  return (
    <Link
      className={className}
      onClick={(e) => e.stopPropagation()}
      params={{ projectId, entityId: id }}
      to={`/p/$projectId/${section}/$entityId` as '/p/$projectId/actors/$entityId'}
    >
      {children}
    </Link>
  );
}

/** Avatar chip that links to the entity profile. */
export function EntityLink({
  projectId,
  kind,
  id,
  name,
  type,
  meta,
  className,
}: {
  projectId: string;
  kind: EntityKind;
  id: string;
  name?: string;
  type?: string;
  meta?: ReactNode;
  className?: string;
}) {
  const showIcon = !(kind === 'actor' && (type === 'user' || type === 'anonymous'));
  return (
    <EntityProfileLink
      className={cn(
        'min-w-0 rounded-sm outline-none hover:underline hover:decoration-muted-foreground/40 hover:underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring/50',
        className,
      )}
      id={id}
      kind={kind}
      projectId={projectId}
      type={type}
    >
      <EntityChip icon={showIcon ? typeIcon(kind, type ?? '') : undefined} id={id} meta={meta} name={name} square={kind !== 'actor'} />
    </EntityProfileLink>
  );
}
