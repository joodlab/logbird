import { type AuditEvent, type ProjectSetup, SAMPLE_DATA_EVENTS, SAMPLE_DATA_SOURCE } from '@logbird/contracts';
import { OutcomeDot, SeverityBadge } from '@logbird/ui/components/badges';
import { CodeTabs } from '@logbird/ui/components/code-block';
import { EntityChip } from '@logbird/ui/components/entity-chip';
import { ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { useConfirm } from '@logbird/ui/components/ui/confirm';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { cn } from '@logbird/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRightIcon, CheckIcon, DatabaseIcon, Loader2Icon, PanelRightOpenIcon, Rows3Icon, SendIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ActionName } from '@/components/action-name';
import { AdminOnly } from '@/components/admin-gate';
import { EventSheet } from '@/components/explorer/event-sheet';
import { Timestamp } from '@/components/timestamp';
import { projectSetupQuery } from '@/lib/api/queries';
import { eventSentence, personLabel } from '@/lib/events';
import { formatNumber } from '@/lib/format';
import { useCan } from '@/lib/permissions';
import { curlSnippet, fetchSnippet, SDK_INSTALL, sdkSnippet } from '@/lib/snippets';
import { useSessionKey } from './api-key-step';
import { useInvalidateSetup, useSampleData, useTestEvent } from './use-setup';

/** How often the first-event step polls setup while nothing has arrived. */
export const FIRST_EVENT_POLL_MS = 2500;

/** curl / TypeScript SDK / fetch, pre-filled with this origin and the session's ingest key. */
export function SendEventSnippets({ projectId }: { projectId: string }) {
  const key = useSessionKey(projectId, 'ingest');
  return (
    <div className="flex flex-col gap-2">
      <CodeTabs
        tabs={[
          { id: 'curl', label: 'curl', code: curlSnippet(key), language: 'bash' },
          { id: 'sdk', label: 'TypeScript SDK', code: `// ${SDK_INSTALL}\n${sdkSnippet(key)}`, language: 'ts' },
          { id: 'fetch', label: 'fetch', code: fetchSnippet(key), language: 'ts' },
        ]}
      />
      {key ? null : (
        <p className="text-muted-foreground text-xs">
          No key in this tab, so the snippets read <span className="font-mono text-foreground">LOGBIRD_INGEST_KEY</span> from the environment. Create
          or paste a key above to fill them in.
        </p>
      )}
    </div>
  );
}

/**
 * The first-event moment, shared by onboarding and the Setup page: snippets, a live listener that polls setup every
 * few seconds while `firstEventAt` is null, a short celebration and the received event when it lands, plus the test
 * event and sample data shortcuts.
 */
export function FirstEventPanel({ projectId, showSnippets = true }: { projectId: string; showSnippets?: boolean }) {
  const setup = useQuery(projectSetupQuery(projectId, { pollUntilFirstEvent: FIRST_EVENT_POLL_MS }));
  const data = setup.data;
  const first = data?.ingest.firstEvent ?? null;
  const invalidate = useInvalidateSetup(projectId);

  // Celebrate only when the event arrives while this panel is watching.
  const sawEmpty = useRef<boolean | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (!data) return;
    if (sawEmpty.current === null) sawEmpty.current = !data.ingest.firstEventAt;
    else if (sawEmpty.current && data.ingest.firstEventAt) {
      sawEmpty.current = false;
      setCelebrate(true);
      invalidate();
      toast.success('First event received', { description: 'Your integration works. Everything else builds on this.' });
    }
  }, [data, invalidate]);

  if (setup.isPending) return <Skeleton className="h-40 w-full" />;
  if (setup.isError && !data) return <ErrorState error={setup.error} onRetry={() => setup.refetch()} size="sm" />;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      {showSnippets ? <SendEventSnippets projectId={projectId} /> : null}
      {first ? <ReceivedEvent celebrate={celebrate} event={first} projectId={projectId} /> : <Listening projectId={projectId} setup={data} />}
      <SampleDataControl projectId={projectId} setup={data} />
    </div>
  );
}

function Listening({ projectId, setup }: { projectId: string; setup: ProjectSetup }) {
  const test = useTestEvent(projectId);
  const canSend = useCan()('testEvent.send');
  return (
    <div
      aria-live="polite"
      className="flex flex-col gap-4 rounded-xl border border-dashed bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
      data-testid="first-event-listening"
    >
      <div className="flex items-start gap-3">
        <span className="relative mt-1 flex size-3 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand/50" />
          <span className="relative inline-flex size-3 rounded-full bg-brand" />
        </span>
        <div className="flex flex-col gap-0.5">
          <p className="font-medium text-sm">Listening for your first event…</p>
          <p className="text-muted-foreground text-xs">
            Run a snippet — this updates on its own within a few seconds.
            {setup.ingest.sampleEvents > 0 ? ' Sample data is loaded, but only real events count.' : ''}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
        <AdminOnly allowed={canSend}>
          <Button disabled={test.isPending || !canSend} onClick={() => test.mutate()} size="sm" variant="outline">
            {test.isPending ? <Loader2Icon className="animate-spin" /> : <SendIcon />}
            Send a test event
          </Button>
        </AdminOnly>
        <span className="text-[11px] text-muted-foreground">
          {canSend ? 'Sent from the console as you · counts as a real event' : 'Ask an admin to send one, or run a snippet'}
        </span>
      </div>
    </div>
  );
}

function ReceivedEvent({ projectId, event, celebrate }: { projectId: string; event: AuditEvent; celebrate: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      aria-live="polite"
      className={cn('flex flex-col gap-3 rounded-xl border p-4', 'border-outcome-success/30 bg-outcome-success/[0.04]')}
      data-testid="first-event-received"
    >
      <div className="flex items-start gap-3">
        <span className="relative mt-0.5 flex size-6 shrink-0 items-center justify-center">
          {celebrate ? <span className="tm-burst absolute inset-0 rounded-full bg-outcome-success/40" /> : null}
          <span
            className={cn('relative flex size-6 items-center justify-center rounded-full bg-outcome-success text-white', celebrate && 'tm-celebrate')}
          >
            <CheckIcon className="size-3.5" strokeWidth={3} />
          </span>
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="font-medium text-sm">{celebrate ? 'It works — your first event just arrived' : 'First event received'}</p>
          <p className="text-muted-foreground text-xs">
            <Timestamp format="full" iso={event.receivedAt} /> · via {event.sdk || 'HTTP'}
          </p>
        </div>
      </div>
      <button
        className="flex min-w-0 flex-col gap-2 rounded-lg border bg-background p-3 text-start transition-colors hover:bg-muted/40"
        onClick={() => setOpen(true)}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2">
          <OutcomeDot outcome={event.outcome} />
          <ActionName action={event.action} className="text-[12.5px]" />
          <SeverityBadge hideInfo severity={event.severity} />
          <span className="ms-auto shrink-0 text-muted-foreground text-xs">
            <Timestamp iso={event.timestamp} />
          </span>
        </span>
        <span className="truncate text-sm">{eventSentence(event)}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          {event.actor ? <EntityChip id={event.actor.id} meta={event.actor.type} name={personLabel(event.actor)} /> : null}
          {event.tenant ? <EntityChip id={event.tenant.id} meta="tenant" name={event.tenant.name || event.tenant.id} square /> : null}
          {event.targets.slice(0, 2).map((t) => (
            <EntityChip id={t.id} key={`${t.type}:${t.id}`} meta={t.type} name={t.name || t.id} square />
          ))}
        </span>
      </button>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setOpen(true)} size="sm" variant="outline">
          <PanelRightOpenIcon />
          Event details
        </Button>
        <Button
          nativeButton={false}
          render={<Link params={{ projectId }} search={{ ev: event.id, range: '30d' }} to="/p/$projectId/events" />}
          size="sm"
          variant="ghost"
        >
          <Rows3Icon />
          Open in explorer
          <ArrowRightIcon />
        </Button>
      </div>
      <EventSheet event={event} onOpenChange={setOpen} open={open} projectId={projectId} />
    </div>
  );
}

export function SampleDataControl({ projectId, setup }: { projectId: string; setup: ProjectSetup }) {
  const { load, remove } = useSampleData(projectId);
  const confirmRemove = useConfirmRemoveSampleData(setup.ingest.sampleEvents);
  const manage = useCan()('sampleData.manage');
  const loaded = setup.ingest.sampleEvents > 0;
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="sample-data">
      <div className="flex items-start gap-3">
        <DatabaseIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex flex-col gap-0.5">
          <p className="font-medium text-sm">
            {loaded
              ? `${formatNumber(setup.ingest.sampleEvents)} sample events loaded`
              : manage
                ? 'Just looking around? Load sample data'
                : 'No sample data loaded'}
          </p>
          <p className="text-muted-foreground text-xs">
            {formatNumber(SAMPLE_DATA_EVENTS)} fictional hotel-booking events over 7 days, tagged{' '}
            <span className="font-mono text-foreground">source:{SAMPLE_DATA_SOURCE}</span>. They fill the dashboards but never count toward setup.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {loaded ? (
          <>
            <Button
              nativeButton={false}
              render={<Link params={{ projectId }} search={{ q: `source:${SAMPLE_DATA_SOURCE}`, range: '7d' }} to="/p/$projectId/events" />}
              size="sm"
              variant="outline"
            >
              Explore
            </Button>
            {manage ? (
              <Button
                disabled={remove.isPending}
                onClick={async () => {
                  if (await confirmRemove()) remove.mutate();
                }}
                size="sm"
                variant="ghost"
              >
                {remove.isPending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
                Remove
              </Button>
            ) : null}
          </>
        ) : manage ? (
          <Button disabled={load.isPending} onClick={() => load.mutate()} size="sm" variant="outline">
            {load.isPending ? <Loader2Icon className="animate-spin" /> : <DatabaseIcon />}
            {load.isPending ? 'Loading…' : 'Load sample data'}
          </Button>
        ) : (
          <span className="text-muted-foreground text-xs">Ask an admin to load it</span>
        )}
      </div>
    </div>
  );
}

/** The one confirmation before removing sample data (Setup, the onboarding first-event step and the sample-data banner). */
export function useConfirmRemoveSampleData(count: number) {
  const confirm = useConfirm();
  return () =>
    confirm({
      title: 'Remove sample data?',
      description: `Deletes the ${formatNumber(count)} events tagged source:${SAMPLE_DATA_SOURCE}. Your real events are not touched.`,
      confirmLabel: 'Remove sample data',
      destructive: true,
    });
}
