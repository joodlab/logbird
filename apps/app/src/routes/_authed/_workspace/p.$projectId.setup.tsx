import type { ProjectSetup, SetupStep, SetupStepId } from '@logbird/contracts';
import { CodeBlock, CodeTabs } from '@logbird/ui/components/code-block';
import { ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@logbird/ui/components/ui/collapsible';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { cn } from '@logbird/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useLocation } from '@tanstack/react-router';
import { ArrowRightIcon, ArrowUpRightIcon, CheckIcon, ChevronDownIcon, EyeIcon, EyeOffIcon, Loader2Icon, PartyPopperIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { EnvelopeSemantics, EventIdsAndRetries, QueryCheatsheet, ShortcutList } from '@/components/docs/reference';
import { InviteForm } from '@/components/members/invite-form';
import { ApiKeyStep, useSessionKey } from '@/components/setup/api-key-step';
import { EnvelopePanel } from '@/components/setup/envelope-panel';
import { FirstEventPanel } from '@/components/setup/first-event-panel';
import { ProgressBar, STATUS_LABEL, StepStatusIcon, stepAnchor, stepCopy } from '@/components/setup/steps';
import { useDismissSetup, useReviewRetention } from '@/components/setup/use-setup';
import { Timestamp } from '@/components/timestamp';
import { projectSetupQuery } from '@/lib/api/queries';
import { formatNumber, formatRetention } from '@/lib/format';
import { useOrganization } from '@/lib/organization';
import { useCan } from '@/lib/permissions';
import { OPERATION_EXAMPLE, readCurlSnippet, readFetchSnippet } from '@/lib/snippets';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/setup')({
  staticData: { crumb: 'Setup' },
  head: () => ({ meta: [{ title: 'Setup · Logbird' }] }),
  loader: ({ context, params }) => {
    context.queryClient.prefetchQuery(projectSetupQuery(params.projectId));
  },
  component: SetupPage,
});

function SetupPage() {
  const { projectId } = Route.useParams();
  const setup = useQuery(projectSetupQuery(projectId));
  const hash = useLocation({ select: (l) => l.hash });

  if (setup.isError && !setup.data) {
    return (
      <div className="p-6">
        <ErrorState error={setup.error} onRetry={() => setup.refetch()} title="Could not load setup status" />
      </div>
    );
  }
  const data = setup.data;
  const required = data?.steps.filter((s) => s.required) ?? [];
  const recommended = data?.steps.filter((s) => !s.required) ?? [];

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-10 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_220px]">
      <article className="flex min-w-0 flex-col gap-8">
        <SetupHeader projectId={projectId} setup={data} />
        {data ? (
          <>
            <StepGroup hash={hash} label="Required" projectId={projectId} setup={data} steps={required} />
            <StepGroup hash={hash} label="Recommended" projectId={projectId} setup={data} steps={recommended} />
          </>
        ) : (
          <div className="flex flex-col gap-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton className="h-28 w-full rounded-xl" key={i} />
            ))}
          </div>
        )}
        <Reference projectId={projectId} />
      </article>
      <Toc setup={data} />
    </div>
  );
}

function SetupHeader({ projectId, setup }: { projectId: string; setup?: ProjectSetup }) {
  const dismiss = useDismissSetup(projectId);
  const manage = useCan()('setup.manage');
  const requiredDone = setup?.steps.filter((s) => s.required && s.status === 'done').length ?? 0;
  const requiredTotal = setup?.steps.filter((s) => s.required).length ?? 0;
  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-2xl tracking-tight">Setup</h1>
        <p className="max-w-2xl text-muted-foreground">
          Everything a production integration needs, checked live against what your project actually receives. Logbird accepts any JSON object with an{' '}
          <span className="font-mono text-foreground">action</span> — start small, then grow into the recommended envelope.
        </p>
      </div>
      {setup ? (
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs" data-testid="setup-progress">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              {setup.complete ? <PartyPopperIcon className="size-4 text-brand" /> : null}
              <span className="font-medium text-sm tabular-nums">
                {setup.complete
                  ? 'All set — every step is done'
                  : setup.completedAt
                    ? `${setup.progress.done} of ${setup.progress.total} checks passing`
                    : `${setup.progress.done} of ${setup.progress.total} steps done`}
              </span>
              <span className="text-muted-foreground text-xs tabular-nums">
                · required {requiredDone}/{requiredTotal}
              </span>
              {setup.completedAt ? (
                <span className="text-muted-foreground text-xs" data-testid="setup-completed-at">
                  · first completed <Timestamp format="date" iso={setup.completedAt} />
                </span>
              ) : null}
            </div>
            {setup.complete || setup.completedAt || !manage ? null : setup.dismissedAt ? (
              <Button disabled={dismiss.isPending} onClick={() => dismiss.mutate(false)} size="sm" variant="outline">
                {dismiss.isPending ? <Loader2Icon className="animate-spin" /> : <EyeIcon />}
                Show checklist on overview
              </Button>
            ) : (
              <Button disabled={dismiss.isPending} onClick={() => dismiss.mutate(true)} size="sm" variant="ghost">
                {dismiss.isPending ? <Loader2Icon className="animate-spin" /> : <EyeOffIcon />}
                Hide from overview
              </Button>
            )}
          </div>
          <ProgressBar done={setup.progress.done} total={setup.progress.total} />
          {setup.nextStep ? (
            <a className="inline-flex items-center gap-1 self-start text-brand text-sm hover:underline" href={`#${stepAnchor(setup.nextStep)}`}>
              Next: {stepCopy(setup.nextStep, setup, 'todo').title}
              <ArrowRightIcon className="size-3.5" />
            </a>
          ) : null}
        </div>
      ) : (
        <Skeleton className="h-24 w-full rounded-xl" />
      )}
    </header>
  );
}

function StepGroup({
  label,
  steps,
  setup,
  projectId,
  hash,
}: {
  label: string;
  steps: SetupStep[];
  setup: ProjectSetup;
  projectId: string;
  hash: string;
}) {
  const done = steps.filter((s) => s.status === 'done').length;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider">{label}</h2>
        <span className="text-muted-foreground text-xs tabular-nums">
          {done}/{steps.length}
        </span>
      </div>
      {steps.map((step) => (
        <StepSection hash={hash} key={step.id} projectId={projectId} setup={setup} step={step} />
      ))}
    </section>
  );
}

function StepSection({ step, setup, projectId, hash }: { step: SetupStep; setup: ProjectSetup; projectId: string; hash: string }) {
  const copy = stepCopy(step.id, setup, step.status);
  const anchor = stepAnchor(step.id);
  // Done steps start folded so the page reads as "what is left"; a deep link always opens its step.
  const defaultOpen = step.status !== 'done' || hash === anchor;
  return (
    <Collapsible
      className={cn(
        'scroll-mt-20 rounded-xl border bg-card shadow-xs',
        step.status === 'attention' && 'border-outcome-denied/30',
        hash === anchor && 'ring-2 ring-brand/30',
      )}
      data-status={step.status}
      data-testid={`step-${step.id}`}
      defaultOpen={defaultOpen}
      id={anchor}
      key={`${anchor}-${hash === anchor}`}
    >
      <CollapsibleTrigger className="group flex w-full items-start gap-3 p-4 text-start sm:p-5">
        <StepStatusIcon className="mt-0.5" status={step.status} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-semibold text-[15px]">{copy.title}</span>
            <span
              className={cn(
                'text-xs',
                step.status === 'done'
                  ? 'text-outcome-success-foreground'
                  : step.status === 'attention'
                    ? 'text-outcome-denied-foreground'
                    : 'text-muted-foreground',
              )}
            >
              {STATUS_LABEL[step.status]}
              {step.status === 'done' && step.completedAt ? (
                <>
                  {' '}
                  · <Timestamp format="date" iso={step.completedAt} />
                </>
              ) : null}
            </span>
          </span>
          <span className="text-muted-foreground text-sm">{copy.detail}</span>
        </div>
        <ChevronDownIcon className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-4 border-t px-4 py-4 sm:px-5">
          <StepBody id={step.id} projectId={projectId} setup={setup} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StepBody({ id, setup, projectId }: { id: SetupStepId; setup: ProjectSetup; projectId: string }) {
  switch (id) {
    case 'ingest_key':
      return <ApiKeyStep kind="ingest" projectId={projectId} />;
    case 'first_event':
      return <FirstEventPanel projectId={projectId} />;
    case 'recent_events':
      return <RecentEvents projectId={projectId} setup={setup} />;
    case 'envelope':
      return <EnvelopePanel projectId={projectId} setup={setup} />;
    case 'operation_id':
      return <OperationStep projectId={projectId} setup={setup} />;
    case 'retention':
      return <RetentionStep projectId={projectId} setup={setup} />;
    case 'read_key':
      return <ReadKeyStep projectId={projectId} />;
    case 'teammate':
      return <TeammateStep projectId={projectId} />;
    default:
      return null;
  }
}

function RecentEvents({ projectId, setup }: { projectId: string; setup: ProjectSetup }) {
  const { ingest } = setup;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Fact label="Last 24 hours" value={formatNumber(ingest.eventsLast24h)} />
        <Fact label="Last event" value={<Timestamp fallback="never" format="relative" iso={ingest.lastEventAt} />} />
        <Fact label="Active ingest keys" value={formatNumber(ingest.activeIngestKeys)} />
      </dl>
      <p className="text-muted-foreground text-sm">
        Track events where data changes — API handlers, workers, schedulers, webhooks — not only from the UI. If events stopped, check that the ingest
        key was not revoked and that your process calls <span className="font-mono text-foreground">shutdown()</span> or{' '}
        <span className="font-mono text-foreground">flush()</span> before exiting.
      </p>
      <Button
        className="self-start"
        nativeButton={false}
        render={<Link params={{ projectId }} search={{ live: true, range: '1h' }} to="/p/$projectId/events" />}
        size="sm"
        variant="outline"
      >
        Open live tail
        <ArrowUpRightIcon />
      </Button>
    </div>
  );
}

function OperationStep({ projectId, setup }: { projectId: string; setup: ProjectSetup }) {
  const example = setup.ingest.firstEvent?.context.operationId;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        <span className="font-mono text-foreground">context.operationId</span> ties together everything one user action caused: the API request, the
        jobs it queued and every record they changed. The operation view then shows the whole causation tree with timing. Add{' '}
        <span className="font-mono text-foreground">parentEventId</span> to draw the edges.
      </p>
      {setup.envelope.sampledEvents > 0 ? (
        <p className="text-sm">
          <span className="font-medium tabular-nums">{Math.round(setup.operations.coverage * 100)}%</span>{' '}
          <span className="text-muted-foreground">
            of recent events carry an operationId ({formatNumber(setup.operations.eventsWithOperationId)}).
          </span>
        </p>
      ) : null}
      <CodeBlock code={OPERATION_EXAMPLE} language="ts" />
      <div className="flex flex-wrap gap-2">
        {example ? (
          <Button
            nativeButton={false}
            render={<Link params={{ projectId, operationId: example }} to="/p/$projectId/operations/$operationId" />}
            size="sm"
            variant="outline"
          >
            View an operation
            <ArrowUpRightIcon />
          </Button>
        ) : null}
        <Button
          nativeButton={false}
          render={<Link params={{ projectId }} search={{ q: 'operation:*', range: '7d' }} to="/p/$projectId/events" />}
          size="sm"
          variant="ghost"
        >
          Events with an operation
          <ArrowUpRightIcon />
        </Button>
      </div>
    </div>
  );
}

function RetentionStep({ projectId, setup }: { projectId: string; setup: ProjectSetup }) {
  const review = useReviewRetention(projectId);
  const manage = useCan()('retention.manage');
  const reviewed = Boolean(setup.retention.reviewedAt);
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm">
          Events are kept for <span className="font-semibold">{formatRetention(setup.retention.retentionDays)}</span>, then permanently deleted by the
          nightly purge.
        </p>
        <p className="text-muted-foreground text-xs">
          {reviewed ? (
            <>
              Reviewed <Timestamp format="relative" iso={setup.retention.reviewedAt} />. Changing the window counts as a review too.
            </>
          ) : (
            'Match it to your compliance policy (SOC 2 and ISO 27001 audits usually ask for at least a year).'
          )}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          nativeButton={false}
          render={<Link params={{ projectId }} to="/p/$projectId/settings/retention" />}
          size="sm"
          variant={reviewed || !manage ? 'outline' : 'ghost'}
        >
          {manage ? 'Change retention' : 'View retention'}
        </Button>
        {reviewed ? null : manage ? (
          <Button disabled={review.isPending} onClick={() => review.mutate()} size="sm">
            {review.isPending ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
            Looks good
          </Button>
        ) : (
          <span className="self-center text-muted-foreground text-xs" data-testid="ask-an-admin">
            Ask an admin to review it
          </span>
        )}
      </div>
    </div>
  );
}

function ReadKeyStep({ projectId }: { projectId: string }) {
  const key = useSessionKey(projectId, 'read');
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        Read keys can only read. Use one in your product's backend to show customers their own history (filter by{' '}
        <span className="font-mono text-foreground">tenant:</span>) — never ship it to a browser.
      </p>
      <ApiKeyStep kind="read" projectId={projectId} />
      <CodeTabs
        tabs={[
          { id: 'curl', label: 'curl', code: readCurlSnippet(key), language: 'bash' },
          { id: 'fetch', label: 'fetch', code: readFetchSnippet(key), language: 'ts' },
        ]}
      />
    </div>
  );
}

function TeammateStep({ projectId }: { projectId: string }) {
  const { org, pending } = useOrganization();
  return (
    <div className="flex flex-col gap-3">
      <InviteForm compact />
      <p className="text-muted-foreground text-xs">
        {org.data ? `${org.data.members.length} ${org.data.members.length === 1 ? 'member' : 'members'}` : '—'}
        {pending.length ? ` · ${pending.length} pending` : ''} ·{' '}
        <Link className="text-foreground underline underline-offset-2" params={{ projectId }} to="/p/$projectId/settings/members">
          Manage members
        </Link>
      </p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border px-3 py-2">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-medium text-sm tabular-nums">{value}</dd>
    </div>
  );
}

function Reference({ projectId }: { projectId: string }) {
  return (
    <section className="flex flex-col gap-6 border-t pt-8" id="reference">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-lg tracking-tight">Reference</h2>
        <p className="text-muted-foreground text-sm">
          The full API is described at <span className="font-mono text-foreground">/openapi.json</span>; the product spec lives in the repository.
        </p>
      </div>
      <div className="flex flex-col gap-3" id="semantics">
        <h3 className="font-medium">Actor, executor, operation</h3>
        <EnvelopeSemantics />
      </div>
      <EventIdsAndRetries />
      <div className="flex flex-col gap-3 scroll-mt-20" id="query">
        <h3 className="font-medium">Query language</h3>
        <p className="text-muted-foreground text-sm">
          Adjacent terms are ANDed; use <span className="font-mono text-foreground">OR</span> and parentheses for alternatives. Click an example to
          run it in the explorer.
        </p>
        <QueryCheatsheet projectId={projectId} />
      </div>
      <div className="flex flex-col gap-3 scroll-mt-20" id="shortcuts">
        <h3 className="font-medium">Keyboard shortcuts</h3>
        <ShortcutList />
      </div>
    </section>
  );
}

function Toc({ setup }: { setup?: ProjectSetup }) {
  return (
    <nav aria-label="Setup steps" className="hidden lg:block">
      <div className="sticky top-6 flex flex-col gap-1 text-sm">
        <span className="pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">Steps</span>
        {setup?.steps.map((s) => (
          <a
            className="flex items-center gap-2 rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            href={`#${stepAnchor(s.id)}`}
            key={s.id}
          >
            <StepStatusIcon className="size-4 [&_svg]:size-4" status={s.status} />
            <span className={cn('truncate', s.status === 'done' && 'line-through decoration-muted-foreground/40')}>
              {stepCopy(s.id, setup, s.status).title}
            </span>
          </a>
        ))}
        <span className="pt-3 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">Reference</span>
        {[
          ['semantics', 'Actor, executor, operation'],
          ['query', 'Query language'],
          ['shortcuts', 'Keyboard shortcuts'],
        ].map(([id, label]) => (
          <a className="rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground" href={`#${id}`} key={id}>
            {label}
          </a>
        ))}
      </div>
    </nav>
  );
}
