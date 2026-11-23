import { TriangleAlertIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Timestamp } from '@/components/timestamp';
import { nextPurgeState } from '@/lib/retention';

/** One fact in the Retention status grid: a label, the value, and an optional line of detail. */
export function StatusItem({ label, children, detail }: { label: string; children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 font-medium text-sm">{children}</dd>
      {detail ? <dd className="text-muted-foreground text-xs">{detail}</dd> : null}
    </div>
  );
}

/**
 * The next purge, never as a past time: past its time it is running now or overdue, and overdue means the retention
 * worker is delayed or stopped (#318).
 */
export function NextPurge({ at, running }: { at: string | null; running: boolean }) {
  // Time moves on even when the status does not change: look again every 15 s.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const state = nextPurgeState(at, now, running);
  if (state === 'none')
    return (
      <StatusItem detail="The worker schedules it hourly" label="Next purge">
        <span className="font-normal text-muted-foreground">Not scheduled</span>
      </StatusItem>
    );
  if (state === 'scheduled')
    return (
      <StatusItem detail={<Timestamp format="full" iso={at} />} label="Next purge">
        <Timestamp format="relative" iso={at} />
      </StatusItem>
    );
  if (state === 'running')
    // The scheduled time is past and a purge is in progress: no stale time beside "now".
    return (
      <StatusItem detail="The purge in progress, under Last purge." label="Next purge">
        Running now
      </StatusItem>
    );
  return (
    <StatusItem
      detail={
        <span data-testid="purge-overdue">
          Due since <Timestamp format="full" iso={at} />. The retention worker may be delayed or stopped. Ask whoever runs Logbird to check it.
        </span>
      }
      label="Next purge"
    >
      <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
        <TriangleAlertIcon aria-hidden className="size-3.5" />
        Overdue
      </span>
      <span className="font-normal text-muted-foreground">
        due <Timestamp format="relative" iso={at} />
      </span>
    </StatusItem>
  );
}
