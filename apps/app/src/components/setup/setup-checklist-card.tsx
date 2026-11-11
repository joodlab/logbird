import type { ProjectSetup, SetupStep } from '@logbird/contracts';
import { StableText } from '@logbird/ui/components/stable-text';
import { Button } from '@logbird/ui/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@logbird/ui/components/ui/collapsible';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@logbird/ui/components/ui/tooltip';
import { cn } from '@logbird/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, ChevronDownIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { projectSetupQuery } from '@/lib/api/queries';
import { useCan } from '@/lib/permissions';
import { ProgressBar, ProgressRing, StepStatusIcon, stepAnchor, stepCopy } from './steps';
import { useDismissSetup } from './use-setup';

const EXPANDED_KEY = 'logbird.setupCard.expanded';
function readExpanded() {
  try {
    return window.localStorage.getItem(EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}
function writeExpanded(value: boolean) {
  try {
    window.localStorage.setItem(EXPANDED_KEY, value ? '1' : '0');
  } catch {
    // Per-viewer convenience only.
  }
}

/**
 * Overview setup checklist. Compact by default (one row: progress + the next step's action) so the KPIs stay above
 * the fold; expands into required / recommended columns. Hidden once complete or dismissed (dismissal is
 * workspace-wide and reversible from the Setup page), for good once setup was completed the first time, and for
 * members: the remaining steps are integration tasks only owners and admins can do.
 */
export function SetupChecklistCard({ projectId, projectName }: { projectId: string; projectName?: string }) {
  const setup = useQuery(projectSetupQuery(projectId));
  const dismiss = useDismissSetup(projectId);
  const canDismiss = useCan()('setup.manage');
  const [expanded, setExpanded] = useState(readExpanded);
  const data = setup.data;

  if (!canDismiss) return null;
  if (setup.isPending) return <Skeleton className="h-[92px] w-full rounded-xl" />;
  // A failing checklist must never block the dashboard; the Setup page shows the error.
  if (!data || data.complete || data.completedAt || data.dismissedAt) return null;

  const next = data.steps.find((s) => s.id === data.nextStep);
  const nextCopy = next ? stepCopy(next.id, data, next.status) : null;
  const required = data.steps.filter((s) => s.required);
  const recommended = data.steps.filter((s) => !s.required);
  const requiredLeft = required.filter((s) => s.status !== 'done').length;

  return (
    <Collapsible
      className="tm-fade-in overflow-hidden rounded-xl border bg-card shadow-xs"
      data-testid="setup-checklist"
      onOpenChange={(open) => {
        setExpanded(open);
        writeExpanded(open);
      }}
      open={expanded}
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <div className="relative hidden size-9 shrink-0 items-center justify-center sm:flex">
            <ProgressRing done={data.progress.done} size={36} total={data.progress.total} />
            <span className="absolute font-semibold text-[11px] tabular-nums">
              {data.progress.done}/{data.progress.total}
            </span>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="font-medium text-sm">
              Finish setting up {projectName ?? 'this project'}
              <span className="block font-normal text-muted-foreground text-xs tabular-nums sm:ms-2 sm:inline">
                {data.progress.done} of {data.progress.total} done
                {requiredLeft ? ` · ${requiredLeft} required left` : ' · required steps done'}
              </span>
            </p>
            {nextCopy && next ? (
              <p className="truncate text-muted-foreground text-sm">
                <span className="text-foreground">Next:</span> {nextCopy.title} — {nextCopy.detail}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {nextCopy && next ? (
              <Button
                className="hidden sm:inline-flex"
                nativeButton={false}
                render={<Link hash={stepAnchor(next.id)} params={{ projectId }} to="/p/$projectId/setup" />}
                size="sm"
              >
                {nextCopy.action}
                <ArrowRightIcon />
              </Button>
            ) : null}
            <CollapsibleTrigger render={<Button aria-label={expanded ? 'Collapse checklist' : 'Show all steps'} size="sm" variant="ghost" />}>
              <StableText className="hidden md:inline-grid" reserve={['All steps', 'Less']}>
                {expanded ? 'Less' : 'All steps'}
              </StableText>
              <ChevronDownIcon className={cn('transition-transform', expanded && 'rotate-180')} />
            </CollapsibleTrigger>
            {canDismiss ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Dismiss setup checklist"
                      disabled={dismiss.isPending}
                      onClick={() => dismiss.mutate(true)}
                      size="icon-sm"
                      variant="ghost"
                    />
                  }
                >
                  <XIcon />
                </TooltipTrigger>
                <TooltipContent>Hide for everyone in the workspace · reopen from Finish setup</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
        <ProgressBar done={data.progress.done} total={data.progress.total} />
        {nextCopy && next ? (
          <Button
            className="sm:hidden"
            nativeButton={false}
            render={<Link hash={stepAnchor(next.id)} params={{ projectId }} to="/p/$projectId/setup" />}
            size="sm"
          >
            {nextCopy.action}
            <ArrowRightIcon />
          </Button>
        ) : null}
      </div>
      <CollapsibleContent>
        <div className="grid gap-x-6 gap-y-4 border-t bg-muted/20 p-4 md:grid-cols-2">
          <StepColumn label="Required" projectId={projectId} setup={data} steps={required} />
          <StepColumn label="Recommended" projectId={projectId} setup={data} steps={recommended} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StepColumn({ label, steps, setup, projectId }: { label: string; steps: SetupStep[]; setup: ProjectSetup; projectId: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
        {label} · {steps.filter((s) => s.status === 'done').length}/{steps.length}
      </p>
      <ul className="flex flex-col">
        {steps.map((step) => {
          const copy = stepCopy(step.id, setup, step.status);
          return (
            <li key={step.id}>
              <Link
                className="group flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-muted/60"
                data-status={step.status}
                hash={stepAnchor(step.id)}
                params={{ projectId }}
                to="/p/$projectId/setup"
              >
                <StepStatusIcon className="mt-px size-4 [&_svg]:size-4" status={step.status} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn('text-sm', step.status === 'done' ? 'text-muted-foreground' : 'font-medium')}>{copy.title}</span>
                  <span className="line-clamp-1 text-muted-foreground text-xs">{copy.detail}</span>
                </span>
                {step.status === 'done' ? null : (
                  <span className="mt-0.5 shrink-0 text-brand text-xs opacity-80 group-hover:opacity-100">{copy.action} →</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
