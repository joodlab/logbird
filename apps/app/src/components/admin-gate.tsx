import { Tooltip, TooltipContent, TooltipTrigger } from '@logbird/ui/components/ui/tooltip';
import { cn } from '@logbird/ui/lib/utils';
import { LockIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ADMINS_ONLY_HINT } from '@/lib/permissions';

/**
 * Explains why a control is disabled. Disabled buttons swallow pointer events, so the tooltip hangs off a wrapper
 * (and screen readers get the reason as text next to the control). Without a `reason` it renders the control untouched.
 */
export function DisabledReason({ reason, children, className }: { reason: ReactNode | null | undefined; children: ReactNode; className?: string }) {
  if (!reason) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn('inline-flex cursor-not-allowed', className)} data-testid="disabled-reason" />}>
        {children}
        <span className="sr-only">{reason}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/** A disabled admin control for members: "Admins only" on hover/focus. Callers disable the control themselves. */
export function AdminOnly({ allowed, children, className }: { allowed: boolean; children: ReactNode; className?: string }) {
  return (
    <DisabledReason className={className} reason={allowed ? null : ADMINS_ONLY_HINT}>
      {children}
    </DisabledReason>
  );
}

/** Inline read-only note for a section a member can see but not change. */
export function AdminNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn('flex items-start gap-2 rounded-lg border border-dashed px-3 py-2.5 text-muted-foreground text-sm', className)}
      data-testid="admin-note"
    >
      <LockIcon className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
