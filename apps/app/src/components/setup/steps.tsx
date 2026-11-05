import type { ProjectSetup, SetupStep, SetupStepId } from '@trailmark/contracts';
import { cn } from '@trailmark/ui/lib/utils';
import { CheckIcon, CircleAlertIcon } from 'lucide-react';
import { formatRelative, formatRetention, pluralize } from '@/lib/format';

/** Anchor on the Setup page for each step (`/p/$projectId/setup#first-event`). */
export const stepAnchor = (id: SetupStepId) => id.replace(/_/g, '-');

export interface StepCopy {
  title: string;
  /** One line under the title; reflects live state (counts, percentages, last event…). */
  detail: string;
  /** Primary action label (the action itself lives on the Setup page section). */
  action: string;
}

/** Title, live one-liner and call to action for each checklist step. */
export function stepCopy(id: SetupStepId, setup: ProjectSetup, status: SetupStep['status']): StepCopy {
  const done = status === 'done';
  switch (id) {
    case 'ingest_key':
      return {
        title: 'Create an ingest key',
        detail: done
          ? `${setup.ingest.activeIngestKeys} active ingest ${setup.ingest.activeIngestKeys === 1 ? 'key' : 'keys'}. Your backend sends events with it.`
          : 'Your backend authenticates to POST /v1/events with a project-bound ingest key.',
        action: done ? 'Manage keys' : 'Create key',
      };
    case 'first_event':
      return {
        title: 'Send your first event',
        detail: done
          ? `First event received ${formatRelative(setup.ingest.firstEventAt)}.`
          : status === 'attention'
            ? 'Only sample data so far — sample events never count. Send one real event.'
            : 'Any JSON object with an action is a valid event. One curl is enough.',
        action: done ? 'View event' : 'Send event',
      };
    case 'recent_events':
      return {
        title: 'Keep events flowing',
        detail: done
          ? `${pluralize(setup.ingest.eventsLast24h, 'event')} in the last 24 hours.`
          : setup.ingest.lastEventAt
            ? `Nothing in the last 24 hours — last event ${formatRelative(setup.ingest.lastEventAt)}.`
            : 'Wire the SDK into the code paths that change data, so events arrive every day.',
        action: 'Check ingestion',
      };
    case 'envelope':
      return {
        title: 'Fill in the recommended envelope',
        detail:
          setup.envelope.sampledEvents === 0
            ? `Average conformance must reach ${setup.envelope.target}% — measured once events arrive.`
            : // "Real": sample data never counts here, while the Overview KPI averages every event in its range.
              `Real events average ${Math.round(setup.envelope.avgConformance)}% conformance (target ${setup.envelope.target}%).`,
        action: done ? 'Review fields' : 'See what is missing',
      };
    case 'operation_id':
      return {
        title: 'Group work with operationId',
        detail: done
          ? `${Math.round(setup.operations.coverage * 100)}% of recent events carry context.operationId.`
          : 'Link a request, the jobs it spawned and every record they changed into one operation.',
        action: 'Learn how',
      };
    case 'retention':
      return {
        title: 'Review retention',
        detail: done
          ? `Events are kept for ${formatRetention(setup.retention.retentionDays)} — reviewed ${formatRelative(setup.retention.reviewedAt)}.`
          : `Events older than ${formatRetention(setup.retention.retentionDays)} are permanently deleted. Confirm that fits your policy.`,
        action: done ? 'Change' : 'Review',
      };
    case 'read_key':
      return {
        title: 'Create a read key',
        detail: done
          ? `${setup.readKeys.active} active read ${setup.readKeys.active === 1 ? 'key' : 'keys'}.`
          : 'Lets your product show the audit trail to its own users through GET /v1/events.',
        action: done ? 'Manage keys' : 'Create key',
      };
    case 'teammate':
      return {
        title: 'Invite a teammate',
        detail: done
          ? `${setup.team.members} ${setup.team.members === 1 ? 'member' : 'members'}${setup.team.pendingInvitations ? `, ${setup.team.pendingInvitations} pending` : ''}.`
          : 'Audit trails are answered by teams: support, security and on-call engineers.',
        action: done ? 'Manage members' : 'Invite',
      };
    default:
      return { title: id, detail: '', action: 'Open' };
  }
}

export const STATUS_LABEL: Record<SetupStep['status'], string> = { done: 'Done', todo: 'To do', attention: 'Needs attention' };

/** done = filled check, todo = dashed ring, attention = amber alert. */
export function StepStatusIcon({ status, className }: { status: SetupStep['status']; className?: string }) {
  if (status === 'done')
    return (
      <span
        aria-label={STATUS_LABEL.done}
        className={cn('flex size-5 shrink-0 items-center justify-center rounded-full bg-outcome-success text-white', className)}
        role="img"
      >
        <CheckIcon className="size-3" strokeWidth={3} />
      </span>
    );
  if (status === 'attention')
    return (
      <span aria-label={STATUS_LABEL.attention} className={cn('flex size-5 shrink-0 items-center justify-center', className)} role="img">
        <CircleAlertIcon className="size-5 text-outcome-denied" />
      </span>
    );
  return (
    <span
      aria-label={STATUS_LABEL.todo}
      className={cn('flex size-5 shrink-0 rounded-full border-[1.5px] border-muted-foreground/40 border-dashed', className)}
      role="img"
    />
  );
}

/** Circular progress for compact spots (sidebar, collapsed card). */
export function ProgressRing({ done, total, size = 16, className }: { done: number; total: number; size?: number; className?: string }) {
  const stroke = Math.max(2, size / 8);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const ratio = total ? done / total : 0;
  return (
    <svg aria-hidden className={cn('-rotate-90 shrink-0', className)} height={size} viewBox={`0 0 ${size} ${size}`} width={size}>
      <circle className="stroke-muted-foreground/20" cx={size / 2} cy={size / 2} fill="none" r={r} strokeWidth={stroke} />
      <circle
        className="stroke-brand transition-[stroke-dashoffset] duration-500"
        cx={size / 2}
        cy={size / 2}
        fill="none"
        r={r}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - ratio)}
        strokeLinecap="round"
        strokeWidth={stroke}
      />
    </svg>
  );
}

/** Thin linear bar used by the card and the Setup page header. */
export function ProgressBar({ done, total, className }: { done: number; total: number; className?: string }) {
  return (
    <div
      aria-label={`${done} of ${total} setup steps done`}
      aria-valuemax={total}
      aria-valuemin={0}
      aria-valuenow={done}
      className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}
      role="progressbar"
    >
      <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
    </div>
  );
}
