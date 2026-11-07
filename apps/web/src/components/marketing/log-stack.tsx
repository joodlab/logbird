import { cn } from '@logbird/ui/lib/utils';

/**
 * The brand illustration from the mark and the social card: a stack of log entries where the newest one is indigo.
 * It is an illustration, not a screenshot: fictional events from docs/concepts.md, no counts or timings.
 */
const rows: {
  action: string;
  who: string;
  what: string;
  when: string;
  outcome: 'success' | 'failure' | 'denied';
}[] = [
  { action: 'payment.refunded', who: 'Refunds worker · attempt 2', what: 'Booking #1042', when: 'now', outcome: 'success' },
  { action: 'payment.refund_failed', who: 'Refunds worker · attempt 1', what: 'Booking #1042', when: '14:32:12', outcome: 'failure' },
  { action: 'booking.cancelled', who: 'Lina Haddad', what: 'Booking #1042', when: '14:32:10', outcome: 'success' },
  { action: 'room.rate.updated', who: 'Omar Saleh via support', what: 'Room 12', when: '14:18:47', outcome: 'success' },
  { action: 'api_key.revoked', who: 'Yara Nasser', what: 'Ingest key', when: '13:05:02', outcome: 'denied' },
];

const outcomeColor = {
  success: 'bg-outcome-success',
  failure: 'bg-outcome-failure',
  denied: 'bg-outcome-denied',
} as const;

function Action({ value }: { value: string }) {
  const dot = value.indexOf('.');
  return (
    <span className="truncate">
      <span className="text-muted-foreground">{value.slice(0, dot + 1)}</span>
      <span className="text-foreground">{value.slice(dot + 1)}</span>
    </span>
  );
}

export function LogStack({ className, animate = true, limit = rows.length }: { className?: string; animate?: boolean; limit?: number }) {
  return (
    <div aria-hidden="true" className={cn('log-stack flex flex-col gap-2', className)} data-animate={animate}>
      {rows.slice(0, limit).map((row, index) => (
        <div
          className="log-row"
          data-newest={index === 0}
          key={row.action + row.when}
          style={{ '--i': index, opacity: index === 0 ? 1 : Math.max(0.4, 1 - index * 0.13) } as React.CSSProperties}
        >
          <span className={cn('log-dot', index === 0 ? 'bg-brand' : outcomeColor[row.outcome])} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <Action value={row.action} />
            <span className="truncate font-sans text-muted-foreground text-xs">
              {row.who} <span className="text-[var(--subtle)]">→</span> {row.what}
            </span>
          </span>
          <span className={cn('text-xs tabular-nums', index === 0 ? 'font-medium text-brand' : 'text-muted-foreground')}>{row.when}</span>
        </div>
      ))}
    </div>
  );
}
