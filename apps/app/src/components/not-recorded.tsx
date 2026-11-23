import { TypePill } from '@logbird/ui/components/badges';
import { cn } from '@logbird/ui/lib/utils';
import { unlinkedPartyLabel } from '@/lib/events';

/**
 * What the console shows for a party (actor, executor) an event or an operation did not record. The event drawer and
 * the operation page both use it, so the words cannot drift: never a bare "Performed by" with nothing after it.
 */
export function NotRecorded({ className }: { className?: string }) {
  return <span className={cn('text-muted-foreground text-sm', className)}>Not recorded</span>;
}

/**
 * A party recorded without an id: there is no profile to link to, so it reads as plain text, its name (or email) when
 * there is one, else its type. Never an empty link, and never "Not recorded" for a party that was recorded.
 */
export function UnlinkedParty({ party, className }: { party: { name?: string; email?: string; type: string }; className?: string }) {
  const label = unlinkedPartyLabel(party);
  if (label) {
    return (
      <bdi className={cn('min-w-0 max-w-full truncate text-sm', className)} title="Recorded without an ID">
        {label}
      </bdi>
    );
  }
  // A type can be long (up to 64 characters): the pill shrinks and truncates; the full type stays in its text and title.
  return (
    <TypePill className={cn('min-w-0 max-w-full', className)}>
      <span className="min-w-0 truncate" title={party.type}>
        {party.type}
      </span>
    </TypePill>
  );
}
