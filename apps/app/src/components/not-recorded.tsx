import { cn } from '@logbird/ui/lib/utils';

/**
 * What the console shows for a party (actor, executor) an event or an operation did not record. The event drawer and
 * the operation page both use it, so the words cannot drift: never a bare "Performed by" with nothing after it.
 */
export function NotRecorded({ className }: { className?: string }) {
  return <span className={cn('text-muted-foreground text-sm', className)}>Not recorded</span>;
}
