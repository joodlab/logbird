import type { WebhookEndpoint } from '@logbird/contracts';
import { TypePill } from '@logbird/ui/components/badges';
import { CodeBlock } from '@logbird/ui/components/code-block';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { SegmentedControl, SegmentedControlItem } from '@logbird/ui/components/ui/segmented-control';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@logbird/ui/components/ui/sheet';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronDownIcon, HistoryIcon, Loader2Icon, RotateCcwIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Timestamp } from '@/components/timestamp';
import { api } from '@/lib/api/client';
import { keys as queryKeys } from '@/lib/api/queries';
import { formatTerm } from '@/lib/query-language';
import { ATTEMPT_STATUS_LABEL, attemptWhy, DELIVERY_STATUS_LABEL, displayUrl, webhookErrorCopy, webhookRetry } from '@/lib/webhooks';

type Delivery = Awaited<ReturnType<typeof api.webhooks.deliveries>>['data'][number];
const FILTERS = [
  { value: '', label: 'All' },
  { value: 'failed', label: 'Failed' },
  { value: 'pending', label: 'Pending' },
  { value: 'succeeded', label: 'Delivered' },
  { value: 'skipped', label: 'Skipped' },
] as const;

const deliveriesKey = (projectId: string, endpointId: string, status: string) =>
  [...queryKeys.project(projectId), 'webhooks', endpointId, 'deliveries', status] as const;

/** One endpoint's recent deliveries (kept 30 days), newest first, with each attempt and why it failed. */
export function DeliveryLog({
  projectId,
  endpoint,
  open,
  onOpenChange,
}: {
  projectId: string;
  endpoint: WebhookEndpoint;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [status, setStatus] = useState('');
  const log = useInfiniteQuery({
    queryKey: deliveriesKey(projectId, endpoint.id, status),
    queryFn: ({ pageParam, signal }) => api.webhooks.deliveries(projectId, endpoint.id, { status: status || undefined, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open,
    // While a shown delivery waits for its outcome, look again every few seconds so the open log settles by itself.
    refetchInterval: (query) => (open && query.state.data?.pages.some((p) => p.data.some((d) => d.status === 'pending')) ? 3000 : false),
  });
  const rows = log.data?.pages.flatMap((p) => p.data) ?? [];
  const { host, path } = displayUrl(endpoint.url);
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-full gap-0 sm:max-w-xl" side="right">
        <SheetHeader className="border-b">
          <SheetTitle>Delivery log</SheetTitle>
          <SheetDescription className="truncate">
            <span className="font-mono">
              {host}
              {path}
            </span>{' '}
            · the last 30 days, newest first
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <SegmentedControl aria-label="Show deliveries" className="self-start">
            {FILTERS.map((f) => (
              <SegmentedControlItem active={status === f.value} aria-pressed={status === f.value} key={f.value} onClick={() => setStatus(f.value)}>
                {f.label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          {log.isPending ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : log.isError ? (
            <ErrorState error={log.error} onRetry={() => log.refetch()} size="sm" title="Could not load deliveries" />
          ) : rows.length === 0 ? (
            <EmptyState
              description={
                status
                  ? 'Nothing with this status in the last 30 days.'
                  : 'Nothing sent in the last 30 days. Matching events are sent as they arrive; a test ping shows up here too.'
              }
              icon={HistoryIcon}
              size="sm"
              title="No deliveries"
            />
          ) : (
            <ul aria-busy={log.isFetchingNextPage || undefined} className="flex flex-col gap-2" data-testid="webhook-deliveries">
              {rows.map((d) => (
                <DeliveryRow delivery={d} endpointId={endpoint.id} key={d.id} projectId={projectId} />
              ))}
            </ul>
          )}
          {log.hasNextPage ? (
            <Button className="self-center" disabled={log.isFetchingNextPage} onClick={() => log.fetchNextPage()} size="sm" variant="outline">
              {log.isFetchingNextPage ? <Loader2Icon className="animate-spin" /> : null}
              Show older deliveries
            </Button>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function statusTone(status: string): 'brand' | 'neutral' | 'warning' {
  return status === 'failed' ? 'warning' : status === 'succeeded' ? 'brand' : 'neutral';
}

function DeliveryRow({ projectId, endpointId, delivery }: { projectId: string; endpointId: string; delivery: Delivery }) {
  const ids = useId();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(delivery.status === 'failed');
  const resend = useMutation({
    mutationFn: () => api.webhooks.resend(projectId, endpointId, delivery.id),
    ...webhookRetry,
    onSuccess: () => {
      toast.success('Queued again', { description: 'It is sent within seconds; this log updates when it is.' });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.project(projectId), 'webhooks', endpointId, 'deliveries'] });
    },
    onError: (error) => toast.error('Could not send it again', { description: webhookErrorCopy(error) }),
  });
  const last = delivery.attempts.at(-1);
  const why = last ? attemptWhy(last, delivery.status === 'pending') : null;
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <TypePill tone={statusTone(delivery.status)}>{DELIVERY_STATUS_LABEL[delivery.status] ?? delivery.status}</TypePill>
        <span className="text-sm">{delivery.kind === 'test' ? 'Test ping' : 'Event'}</span>
        {delivery.kind === 'event' ? (
          <Link
            className="min-w-0 truncate font-mono text-muted-foreground text-xs underline-offset-2 hover:underline"
            params={{ projectId }}
            search={{ q: formatTerm('id', delivery.eventId), ev: delivery.eventId, range: 'all' }}
            to="/p/$projectId/events"
          >
            {delivery.eventId}
          </Link>
        ) : null}
        <span className="ms-auto text-muted-foreground text-xs">
          <Timestamp format="relative" iso={delivery.createdAt} />
        </span>
      </div>
      <p className="text-muted-foreground text-xs">
        {delivery.attemptCount === 0 ? 'Not attempted yet' : `${delivery.attemptCount} ${delivery.attemptCount === 1 ? 'attempt' : 'attempts'}`}
        {last?.responseCode ? ` · last answer ${last.responseCode}` : ''}
        {last?.latencyMs != null ? ` in ${last.latencyMs} ms` : ''}
        {delivery.status === 'pending' && delivery.nextAttemptAt ? (
          <>
            {' · next try '}
            <Timestamp format="relative" iso={delivery.nextAttemptAt} />
          </>
        ) : null}
      </p>
      {why && delivery.status !== 'succeeded' ? <p className="text-sm">{why}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {delivery.attempts.length ? (
          <Button aria-controls={`${ids}-attempts`} aria-expanded={open} onClick={() => setOpen(!open)} size="xs" variant="ghost">
            <ChevronDownIcon className={open ? '' : '-rotate-90'} />
            Attempts
          </Button>
        ) : null}
        {delivery.status !== 'pending' ? (
          <Button disabled={resend.isPending} onClick={() => resend.mutate()} size="xs" variant="outline">
            {resend.isPending ? <Loader2Icon className="animate-spin" /> : <RotateCcwIcon />}
            {resend.isPending && resend.failureCount > 0 ? 'Busy, retrying…' : 'Send again'}
          </Button>
        ) : null}
      </div>
      <ol className="flex flex-col gap-2" hidden={!open} id={`${ids}-attempts`}>
        {delivery.attemptCount > delivery.attempts.length ? (
          <li className="text-muted-foreground text-xs">
            Showing the last {delivery.attempts.length} of {delivery.attemptCount} attempts.
          </li>
        ) : null}
        {delivery.attempts.map((a) => (
          <li className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/40 p-2 text-xs" key={a.number}>
            <span>
              <span className="font-medium">
                #{a.number} {ATTEMPT_STATUS_LABEL[a.status] ?? a.status}
              </span>
              {' · '}
              <Timestamp format="full" iso={a.startedAt} />
              {a.responseCode ? ` · answered ${a.responseCode}` : ''}
              {a.latencyMs != null ? ` in ${a.latencyMs} ms` : ''}
            </span>
            {attemptWhy(a) ? <span>{attemptWhy(a)}</span> : null}
            {a.responseBody ? (
              <CodeBlock code={a.responseBody} copyLabel="Copy response" language="text" maxHeight={160} title="Response (first 2 KiB)" />
            ) : null}
          </li>
        ))}
      </ol>
    </li>
  );
}
