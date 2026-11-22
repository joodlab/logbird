import type { WebhookEndpoint } from '@logbird/contracts';
import { Button } from '@logbird/ui/components/ui/button';
import { cn } from '@logbird/ui/lib/utils';
import { ExternalLinkIcon, Loader2Icon, PauseCircleIcon, TriangleAlertIcon } from 'lucide-react';
import { useId } from 'react';
import { CURSOR_REVIEW_DOCS, type EndpointState, endpointStates } from '@/lib/webhooks';

/**
 * Every hold or warning on an endpoint as its own panel: what happened, whether anything is lost (never: a held
 * endpoint keeps its place), and what to do, with the action when the console has one.
 */
export function EndpointStates({
  endpoint,
  filterError,
  onConfirmFilter,
  confirming,
  onEdit,
  onRotate,
}: {
  endpoint: WebhookEndpoint;
  /** The server's explanation when it rejected the stored filter on confirmation: kept beside the filter. */
  filterError: string | null;
  onConfirmFilter: () => void;
  confirming: boolean;
  onEdit: () => void;
  onRotate: () => void;
}) {
  const states = endpointStates(endpoint);
  if (!states.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {states.map((state) => (
        <StatePanel key={state.key} state={state}>
          {state.key === 'filter' ? (
            <>
              <p className="text-sm">
                Stored filter:{' '}
                <code className="break-all rounded bg-muted px-1 py-0.5 font-mono text-xs" data-testid="held-filter">
                  {endpoint.filterQuery}
                </code>
              </p>
              {filterError ? (
                <p className="text-destructive text-sm" role="alert">
                  {filterError} Edit the filter to fix it.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button disabled={confirming} onClick={onConfirmFilter} size="sm">
                  {confirming ? <Loader2Icon className="animate-spin" /> : null}
                  Confirm this filter
                </Button>
                <Button onClick={onEdit} size="sm" variant="outline">
                  Edit the filter
                </Button>
              </div>
            </>
          ) : state.key === 'scope' ? (
            <Button className="self-start" onClick={onEdit} size="sm" variant="outline">
              Edit the scope
            </Button>
          ) : state.key === 'cursor' ? (
            <a
              className="inline-flex items-center gap-1 self-start text-sm underline underline-offset-2"
              href={CURSOR_REVIEW_DOCS}
              rel="noreferrer"
              target="_blank"
            >
              Operator procedure in the self-hosting guide <ExternalLinkIcon className="size-3.5" />
            </a>
          ) : (
            <Button className="self-start" onClick={onRotate} size="sm" variant="outline">
              Rotate the secret
            </Button>
          )}
        </StatePanel>
      ))}
    </div>
  );
}

function StatePanel({ state, children }: { state: EndpointState; children: React.ReactNode }) {
  const titleId = useId();
  const hold = state.kind === 'hold';
  const Icon = hold ? PauseCircleIcon : TriangleAlertIcon;
  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        'flex flex-col gap-2 rounded-md border p-3 text-sm',
        hold ? 'border-outcome-denied/40 bg-outcome-denied/[0.06]' : 'border-amber-500/40 bg-amber-500/[0.06]',
      )}
      data-state={state.key}
      data-testid="endpoint-state"
    >
      <h3 className="flex items-start gap-2 font-medium" id={titleId}>
        <Icon className={cn('mt-0.5 size-4 shrink-0', hold ? 'text-outcome-denied' : 'text-amber-600')} />
        {state.title}
      </h3>
      <p className="text-muted-foreground">{state.what}</p>
      <p className="text-muted-foreground">{state.lost}</p>
      <p>{state.todo}</p>
      {children}
    </section>
  );
}
