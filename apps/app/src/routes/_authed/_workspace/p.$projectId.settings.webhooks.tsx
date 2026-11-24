import { SCOPE_MASKS, type WebhookEndpoint } from '@logbird/contracts';
import { TypePill } from '@logbird/ui/components/badges';
import { CopyButton } from '@logbird/ui/components/copy-button';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { Checkbox } from '@logbird/ui/components/ui/checkbox';
import { useConfirm } from '@logbird/ui/components/ui/confirm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@logbird/ui/components/ui/dialog';
import { Label } from '@logbird/ui/components/ui/label';
import { RadioChoice, RadioGroup } from '@logbird/ui/components/ui/radio-group';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { Switch } from '@logbird/ui/components/ui/switch';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ChevronDownIcon, Loader2Icon, PlusIcon, TriangleAlertIcon, WebhookIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AdminNote } from '@/components/admin-gate';
import { CloseWithoutCopying, useSecretCloseGuard } from '@/components/one-time-secret';
import { SettingsSection } from '@/components/settings-section';
import { TextField } from '@/components/text-field';
import { Timestamp } from '@/components/timestamp';
import { DeliveryLog } from '@/components/webhooks/delivery-log';
import { DeliveryWindowField } from '@/components/webhooks/delivery-window-field';
import { EndpointStates } from '@/components/webhooks/endpoint-states';
import { api } from '@/lib/api/client';
import { ApiRequestError } from '@/lib/api/errors';
import { keys as queryKeys, webhooksQuery } from '@/lib/api/queries';
import { MASK_HINT, MASK_LABEL } from '@/lib/api-keys';
import { creatorLabel } from '@/lib/events';
import { useOrganization } from '@/lib/organization';
import { useCan } from '@/lib/permissions';
import { queryProblem, queryProblemText, reasonTitle } from '@/lib/query-error';
import {
  deliveryWindowLine,
  disabledCopy,
  displayUrl,
  endpointPatch,
  endpointStates,
  type Form,
  type FormErrors,
  fieldErrorsFromValidation,
  formFrom,
  isHoldRefusal,
  isWebhookBusy,
  MAX_WEBHOOK_ENDPOINTS,
  OVERLAP_CHOICES,
  scopeOf,
  scopeSummary,
  sendBlockedCopy,
  validateWebhookForm,
  webhookErrorCopy,
  webhookRetry,
  windowSeconds,
} from '@/lib/webhooks';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/webhooks')({
  head: () => ({ meta: [{ title: 'Webhooks · Logbird' }] }),
  staticData: { crumb: 'Webhooks' },
  component: WebhooksSettings,
});

type Issued = { endpoint: WebhookEndpoint; secret: string; overlapSeconds: number | null };

function WebhooksSettings() {
  const { projectId } = Route.useParams();
  const can = useCan();
  const list = useQuery({ ...webhooksQuery(projectId), enabled: can.isAdmin });
  const [editing, setEditing] = useState<WebhookEndpoint | 'new' | null>(null);
  // The server's explanation of a filter it rejected, carried into the editor so it stays beside the filter.
  const [editFilterError, setEditFilterError] = useState<string | null>(null);
  // A new endpoint never inherits another endpoint's filter explanation.
  const addEndpoint = () => {
    setEditFilterError(null);
    setEditing('new');
  };
  const [rotating, setRotating] = useState<WebhookEndpoint | null>(null);
  // Every issued secret waits its turn: one finishing while another is on screen never replaces it.
  const [issued, setIssued] = useState<(Issued & { n: number })[]>([]);
  const issuedCount = useRef(0);
  const enqueue = (secret: Issued) => setIssued((queue) => [...queue, { ...secret, n: ++issuedCount.current }]);

  const description = (
    <>
      Logbird sends each new event that matches an endpoint’s filter and scope to its URL as a signed POST, so another system can react to it. Up to{' '}
      {MAX_WEBHOOK_ENDPOINTS} endpoints per project.
    </>
  );
  // Reads are admin-only too: a stored URL can itself be a credential (a Slack- or Zapier-style hook path).
  if (can.ready && !can.isAdmin)
    return (
      <SettingsSection description={description} title="Webhooks">
        <AdminNote>Only workspace owners and admins can see and manage webhooks: an endpoint’s URL can itself be a secret.</AdminNote>
      </SettingsSection>
    );
  const endpoints = list.data ?? [];
  const full = endpoints.length >= MAX_WEBHOOK_ENDPOINTS;
  return (
    <div className="flex flex-col gap-6">
      <SettingsSection
        description={description}
        footer={
          list.data ? (
            <Button
              disabled={full}
              onClick={addEndpoint}
              size="sm"
              title={full ? `A project can have at most ${MAX_WEBHOOK_ENDPOINTS} endpoints.` : undefined}
            >
              <PlusIcon />
              Add endpoint
            </Button>
          ) : null
        }
        title="Webhooks"
      >
        {list.isPending || !can.ready ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} size="sm" title="Could not load webhooks" />
        ) : endpoints.length === 0 ? (
          <EmptyState
            description="Add an endpoint to send this project’s events to Slack, a CRM or your own service as they arrive."
            icon={WebhookIcon}
            size="sm"
            title="No endpoints yet"
          >
            <Button onClick={addEndpoint} size="sm">
              <PlusIcon />
              Add endpoint
            </Button>
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="webhook-endpoints">
            {endpoints.map((endpoint) => (
              <EndpointCard
                endpoint={endpoint}
                key={endpoint.id}
                onEdit={(filterError) => {
                  setEditFilterError(filterError ?? null);
                  setEditing(endpoint);
                }}
                onRotate={() => setRotating(endpoint)}
                projectId={projectId}
              />
            ))}
          </ul>
        )}
      </SettingsSection>
      <EndpointDialog
        endpoint={editing === 'new' ? null : editing}
        filterError={editFilterError}
        onClose={() => {
          setEditing(null);
          setEditFilterError(null);
        }}
        onSecret={enqueue}
        open={editing !== null}
        projectId={projectId}
      />
      <RotateDialog endpoint={rotating} onClose={() => setRotating(null)} onSecret={enqueue} projectId={projectId} />
      <SecretDialog issued={issued[0] ?? null} key={issued[0]?.n ?? 0} onClose={() => setIssued((queue) => queue.slice(1))} />
    </div>
  );
}

function useEndpointMutations(projectId: string) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: [...queryKeys.project(projectId), 'webhooks'] });
  /**
   * The endpoint the server returned replaces the listed one at once, before the list is read again: an Edit opened
   * in between sees the saved values (never the previous filter or its rejection).
   */
  const apply = (updated: WebhookEndpoint) => {
    queryClient.setQueryData(webhooksQuery(projectId).queryKey, (list) => list?.map((e) => (e.id === updated.id ? updated : e)));
    refresh();
  };
  return { refresh, apply };
}

function EndpointCard({
  projectId,
  endpoint,
  onEdit,
  onRotate,
}: {
  projectId: string;
  endpoint: WebhookEndpoint;
  /** Open the editor, optionally with the server's explanation of a rejected filter. */
  onEdit: (filterError?: string) => void;
  onRotate: () => void;
}) {
  const { refresh, apply } = useEndpointMutations(projectId);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { org } = useOrganization();
  const creator = org.data?.members.find((m) => m.userId === endpoint.createdById)?.user;
  const { host, path } = displayUrl(endpoint.url);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.webhooks.update(projectId, endpoint.id, { enabled }),
    ...webhookRetry,
    onSuccess: (updated, enabled) => {
      toast.success(enabled ? 'Endpoint turned on' : 'Endpoint turned off');
      apply(updated);
    },
    onError: (error) => toast.error('Could not change the endpoint', { description: webhookErrorCopy(error) }),
  });
  const remove = useMutation({
    mutationFn: () => api.webhooks.remove(projectId, endpoint.id),
    ...webhookRetry,
    onSuccess: () => {
      toast.success('Endpoint deleted');
      refresh();
    },
    onError: (error) => toast.error('Could not delete the endpoint', { description: webhookErrorCopy(error) }),
  });
  // Confirming the stored filter as it is: a PATCH that includes filterQuery, unchanged, lifts the hold.
  // The server's rejection of a filter belongs to that filter text, and only while the filter hold lasts: once the
  // filter is changed or confirmed, it is gone.
  const [rejected, setRejected] = useState<{ query: string; message: string } | null>(null);
  const filterError = rejected && endpoint.filterWarning && rejected.query === endpoint.filterQuery ? rejected.message : null;
  const confirmFilter = useMutation({
    mutationFn: () => api.webhooks.update(projectId, endpoint.id, { filterQuery: endpoint.filterQuery }),
    ...webhookRetry,
    onSuccess: (updated) => {
      setRejected(null);
      apply(updated);
      // Say what the returned endpoint says: another hold (a scope, an operator review) can still keep it paused.
      const still = endpointStates(updated).filter((s) => s.kind === 'hold');
      if (still.length)
        toast.warning('Filter confirmed, still paused', {
          description: `It also needs: ${still.map((s) => s.badge.replace(/^Held: /, '')).join(', ')}.`,
        });
      else if (!updated.enabled) toast.success('Filter confirmed', { description: 'The endpoint is off: turn it on to resume delivery.' });
      else toast.success('Filter confirmed', { description: 'Delivery resumes where it paused.' });
    },
    onError: (error) => {
      const problem = queryProblem(error, 'query');
      if (problem)
        setRejected({
          query: endpoint.filterQuery,
          message: `${reasonTitle(problem.details, problem.code, problem.message)}: ${queryProblemText(problem, endpoint.filterQuery)}`,
        });
      else toast.error('Could not confirm the filter', { description: webhookErrorCopy(error) });
    },
  });
  const test = useMutation({
    mutationFn: () => api.webhooks.test(projectId, endpoint.id),
    ...webhookRetry,
    onSuccess: () => {
      toast.success('Test ping queued', { description: 'It is sent within seconds and shows up in the delivery log.' });
      queryClient.invalidateQueries({ queryKey: [...queryKeys.project(projectId), 'webhooks', endpoint.id, 'deliveries'] });
    },
    onError: (error) => {
      toast.error('Could not send a test ping', { description: webhookErrorCopy(error, endpoint) });
      // A hold newer than this page: refresh the endpoint so its card shows it.
      if (isHoldRefusal(error)) refresh();
    },
  });
  const [logOpen, setLogOpen] = useState(false);
  const off = !endpoint.enabled;
  const reason = disabledCopy(endpoint.disabledReason);
  const states = endpointStates(endpoint);
  const held = states.find((s) => s.kind === 'hold');
  // The API refuses a test ping while the endpoint is off or held for its filter or scope; cursor review allows it.
  const testBlocked = sendBlockedCopy(endpoint, 'send a test ping');
  const busy = [toggle, remove, confirmFilter, test].some((m) => m.isPending && m.failureCount > 0);
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-lg border p-4" data-testid="webhook-endpoint">
      {/* On a phone the state badge goes under the address, which then keeps the whole width. */}
      <div className="flex min-w-0 items-start justify-between gap-3 max-sm:flex-col max-sm:gap-1.5">
        {/* max-w-full: stacked, the address column may not grow past the card, so the address truncates instead. */}
        <div className="flex min-w-0 max-w-full flex-col gap-0.5">
          <p className="truncate font-mono text-sm">
            {host}
            <span className="text-muted-foreground">{path}</span>
          </p>
          {endpoint.description ? <p className="text-muted-foreground text-sm">{endpoint.description}</p> : null}
        </div>
        <TypePill tone={off || held ? 'warning' : 'brand'}>{off ? 'Off' : held ? held.badge : 'On'}</TypePill>
      </div>
      {off ? (
        <div className="flex items-start gap-2 rounded-md border border-outcome-denied/30 bg-outcome-denied/[0.06] p-3 text-sm" role="status">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-outcome-denied" />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{reason.title}</span>
            <span className="text-muted-foreground">
              {reason.detail}
              {endpoint.disabledAt ? (
                <>
                  {' '}
                  Off since <Timestamp format="full" iso={endpoint.disabledAt} />.
                </>
              ) : null}
            </span>
          </span>
        </div>
      ) : null}
      <EndpointStates
        confirming={confirmFilter.isPending}
        endpoint={endpoint}
        filterError={filterError}
        onConfirmFilter={() => confirmFilter.mutate()}
        onEdit={() => onEdit(filterError ?? undefined)}
        onRotate={onRotate}
      />
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Sends</dt>
        <dd className="min-w-0">
          {endpoint.filterQuery ? <code className="break-all font-mono text-xs">{endpoint.filterQuery}</code> : 'Every event'}
          {' · '}
          {scopeSummary(endpoint.scope)}
        </dd>
        <dt className="text-muted-foreground">Delivery window</dt>
        <dd data-testid="delivery-window">{deliveryWindowLine(endpoint.deliveryWindowSeconds)}</dd>
        <dt className="text-muted-foreground">Created</dt>
        <dd>
          <Timestamp format="date" iso={endpoint.createdAt} />
          {creatorLabel(creator) ? ` by ${creatorLabel(creator)}` : endpoint.createdById && org.data ? ' by a former member' : ''}
        </dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        {/* No edit while a filter confirmation is in flight: it sends the filter it started with and would overwrite it. */}
        <Button disabled={confirmFilter.isPending} onClick={() => onEdit(filterError ?? undefined)} size="sm" variant="outline">
          Edit
        </Button>
        <Button onClick={onRotate} size="sm" variant="outline">
          Rotate secret
        </Button>
        <Button onClick={() => setLogOpen(true)} size="sm" variant="outline">
          Delivery log
        </Button>
        <Button
          disabled={test.isPending || testBlocked !== null}
          onClick={() => test.mutate()}
          size="sm"
          title={testBlocked ?? undefined}
          variant="outline"
        >
          {test.isPending ? <Loader2Icon className="animate-spin" /> : null}
          Send test ping
        </Button>
        <Button disabled={toggle.isPending} onClick={() => toggle.mutate(off)} size="sm" variant="outline">
          {toggle.isPending ? <Loader2Icon className="animate-spin" /> : null}
          {off ? 'Turn on' : 'Turn off'}
        </Button>
        <Button
          disabled={remove.isPending}
          onClick={async () => {
            const ok = await confirm({
              title: `Delete the endpoint for ${host}?`,
              description: 'Logbird stops sending to it immediately and forgets its secret. This cannot be undone.',
              confirmLabel: 'Delete endpoint',
              destructive: true,
            });
            if (ok) remove.mutate();
          }}
          size="sm"
          variant="ghost"
        >
          Delete
        </Button>
        {busy ? (
          <span className="flex items-center gap-1.5 text-muted-foreground text-xs" role="status">
            <Loader2Icon className="size-3.5 animate-spin" /> Busy, retrying…
          </span>
        ) : null}
      </div>
      <DeliveryLog
        endpoint={endpoint}
        onOpenChange={setLogOpen}
        open={logOpen}
        projectId={projectId}
        sendBlocked={sendBlockedCopy(endpoint, 'send a delivery again')}
      />
    </li>
  );
}

/** A save from an earlier opening of the dialog: dropped, never retried. */
class SaveAbandoned extends Error {}

/** The dialog's fields in reading order, and each one's element id suffix, for focusing the first invalid one. */
const FIELD_ORDER = ['url', 'description', 'filter', 'windowAmount', 'tenantId', 'targetType', 'targetId', 'masks'] as const;
const FIELD_IDS: Record<(typeof FIELD_ORDER)[number], string> = {
  url: 'url',
  description: 'description',
  filter: 'filter',
  windowAmount: 'window-amount',
  tenantId: 'tenant',
  targetType: 'target-type',
  targetId: 'target-id',
  masks: 'masks',
};

function EndpointDialog({
  projectId,
  endpoint,
  filterError,
  open,
  onClose,
  onSecret,
}: {
  projectId: string;
  endpoint: WebhookEndpoint | null;
  /** The server's explanation of a rejected filter, shown on the filter field when the editor opens. */
  filterError?: string | null;
  open: boolean;
  onClose: () => void;
  /** A created endpoint's secret, handed straight to the one-time dialog (never kept in mutation state). */
  onSecret: (issued: Issued) => void;
}) {
  const { refresh, apply } = useEndpointMutations(projectId);
  const ids = useId();
  const [form, setForm] = useState<Form>(() => formFrom(endpoint));
  const [wasOpen, setWasOpen] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [narrowOpen, setNarrowOpen] = useState(false);
  // Each opening is a fresh form: for the endpoint being edited, or empty for a new one (never last time's draft).
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setForm(formFrom(endpoint));
      setErrors(filterError ? { filter: filterError } : {});
      setNarrowOpen(Boolean(endpoint?.scope));
    }
  }
  // Every opening and closing starts a new session: a save still retrying from an earlier one stops instead of
  // applying its form to whatever the dialog shows now.
  const session = useRef(0);
  if (open !== wasOpen) session.current += 1;
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  // Shows errors from the form's own checks or the server's, and moves focus to the first field that needs attention,
  // so a keyboard or screen-reader user lands on it and hears its error (each field's error is an alert).
  function showErrors(next: FormErrors) {
    setErrors(next);
    if (next.tenantId || next.targetType || next.targetId || next.masks) setNarrowOpen(true);
    const first = FIELD_ORDER.find((field) => next[field]);
    if (first) requestAnimationFrame(() => document.getElementById(`${ids}-${FIELD_IDS[first]}`)?.focus());
  }
  const onSecretRef = useRef(onSecret);
  onSecretRef.current = onSecret;
  const save = useMutation({
    gcTime: 0,
    // Everything comes from the variables captured at submit: the endpoint, its values then, the form and the session.
    mutationFn: async ({ f, target, at }: { f: Form; target: WebhookEndpoint | null; at: number }) => {
      if (at !== session.current) throw new SaveAbandoned();
      const scope = scopeOf(f);
      if (!target) {
        const result = await api.webhooks.create(projectId, {
          url: f.url.trim(),
          description: f.description.trim() || null,
          filterQuery: f.filter.trim(),
          scope,
          // Sent explicitly (7 days unless changed), so what the form showed is what the endpoint gets.
          deliveryWindowSeconds: windowSeconds(f) ?? null,
        });
        // The endpoint exists now, so its secret is shown whatever happened to this form meanwhile (closed, reopened).
        // It goes straight to the one-time dialog and never enters the mutation's state.
        onSecretRef.current({ endpoint: result.endpoint, secret: result.secret, overlapSeconds: null });
        return { created: result.endpoint };
      }
      const body = endpointPatch(target, f, scope);
      if (!Object.keys(body).length) return null;
      return api.webhooks.update(projectId, target.id, body);
    },
    ...webhookRetry,
    onSuccess: (result, { at }) => {
      if (result && !('created' in result)) apply(result);
      else refresh();
      if (at !== session.current) return;
      if (!(result && 'created' in result)) toast.success(result ? 'Endpoint saved' : 'Nothing to save');
      onClose();
    },
    onError: (error, { f, at }) => {
      if (error instanceof SaveAbandoned || at !== session.current) return;
      const problem = queryProblem(error, 'query');
      if (problem) showErrors({ filter: `${reasonTitle(problem.details, problem.code, problem.message)}: ${queryProblemText(problem, f.filter)}` });
      else if (error instanceof ApiRequestError && error.code === 'webhook_url_not_allowed') showErrors({ url: webhookErrorCopy(error) });
      else {
        // A body the contract rejects names its field: put the message there.
        const onField = fieldErrorsFromValidation(error);
        showErrors(Object.keys(onField).length ? onField : { form: webhookErrorCopy(error) });
      }
    },
  });
  const submit = () => {
    const next = validateWebhookForm(form);
    if (Object.keys(next).length) return showErrors(next);
    setErrors({});
    save.mutate({ f: form, target: endpoint, at: session.current });
  };
  const retrying = save.isPending && save.failureCount > 0 && isWebhookBusy(save.failureReason);
  const scopeInvalid = Boolean(errors.tenantId || errors.targetType || errors.targetId || errors.masks);
  const narrowShown = narrowOpen || scopeInvalid;
  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open={open}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{endpoint ? 'Edit endpoint' : 'Add a webhook endpoint'}</DialogTitle>
          <DialogDescription>
            {endpoint
              ? 'Changes apply to every delivery attempt that starts after you save, retries included. The delivery window is the exception: it applies when events are found, so deliveries already queued still go out.'
              : 'Logbird POSTs each new matching event to this URL, signed with a secret you see once.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <TextField
            error={errors.url}
            id={`${ids}-url`}
            label="URL"
            limits="https only, and the host must resolve to public addresses. Up to 2,048 characters. Only owners and admins can see it, so a token in the path stays private."
            onChange={(url) => set({ url })}
            placeholder="https://hooks.example.com/logbird"
            purpose="Where Logbird POSTs each matching event."
            value={form.url}
          />
          <TextField
            error={errors.description}
            id={`${ids}-description`}
            label="Description"
            limits="Up to 1,000 characters."
            onChange={(description) => set({ description })}
            optional
            placeholder="Billing alerts in Slack"
            purpose="What this endpoint feeds, for your teammates."
            value={form.description}
          />
          <TextField
            error={errors.filter}
            id={`${ids}-filter`}
            label="Filter"
            limits="The query language you use in the explorer, up to 4,096 characters. It is checked when you save, and it cannot use a field the endpoint’s scope hides. In a filter, now (occurredAt:>now-1h) means the time each event arrived."
            multiline
            onChange={(filter) => set({ filter })}
            optional
            placeholder="action:booking.* outcome:failure"
            purpose="Which events to send. Empty sends every event."
            value={form.filter}
          />
          <DeliveryWindowField
            error={errors.windowAmount}
            id={`${ids}-window`}
            onChange={(patch) => {
              set(patch);
              // A new choice answers the old error: "No limit" or a new amount must not keep "Choose from 1 to 3,650 days".
              setErrors((e) => ({ ...e, windowAmount: undefined }));
            }}
            value={form}
          />
          <div className="flex min-w-0 flex-col gap-3">
            <button
              aria-controls={`${ids}-narrow`}
              aria-expanded={narrowShown}
              className="flex items-start gap-1.5 self-start rounded-sm text-start font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={() => setNarrowOpen(scopeInvalid ? true : !narrowShown)}
              type="button"
            >
              <ChevronDownIcon
                className={narrowShown ? 'mt-0.5 size-4 shrink-0 text-muted-foreground' : '-rotate-90 mt-0.5 size-4 shrink-0 text-muted-foreground'}
              />
              <span>
                Only part of the project <span className="font-normal text-muted-foreground">· one tenant or record, hidden fields</span>
              </span>
            </button>
            <div className="flex min-w-0 flex-col gap-3" hidden={!narrowShown} id={`${ids}-narrow`}>
              <TextField
                error={errors.tenantId}
                id={`${ids}-tenant`}
                label="Tenant id"
                limits="Exactly as stored, as on a tenant’s page. Events without a tenant are not sent."
                onChange={(tenantId) => set({ tenantId })}
                optional
                placeholder="biz_7"
                purpose="Send only this tenant’s events."
                value={form.tenantId}
              />
              <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <TextField
                  error={errors.targetType}
                  id={`${ids}-target-type`}
                  label="Record type"
                  limits="The type part of a record, as stored."
                  onChange={(targetType) => set({ targetType })}
                  optional
                  placeholder="booking"
                  value={form.targetType}
                />
                <TextField
                  error={errors.targetId}
                  id={`${ids}-target-id`}
                  label="Record id"
                  limits="The id part of a record, as stored. Both type and id are needed."
                  onChange={(targetId) => set({ targetId })}
                  optional
                  placeholder="bk_123"
                  purpose="Send only events about this record."
                  value={form.targetId}
                />
              </div>
              <fieldset
                aria-describedby={`${ids}-masks-hint`}
                aria-invalid={Boolean(errors.masks) || undefined}
                className="flex min-w-0 flex-col gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                id={`${ids}-masks`}
                // Focusable only from code: an invalid submit moves focus here so the hint below is read out.
                tabIndex={-1}
              >
                <legend className="font-medium text-sm">
                  Hide fields <span className="font-normal text-muted-foreground">· optional</span>
                </legend>
                {SCOPE_MASKS.map((mask) => (
                  // biome-ignore lint/a11y/noLabelWithoutControl: the Base UI checkbox inside is the control.
                  <label className="flex items-start gap-2 text-sm" key={mask}>
                    <Checkbox
                      checked={form.masks.includes(mask)}
                      onCheckedChange={(checked) => set({ masks: checked ? [...form.masks, mask] : form.masks.filter((m) => m !== mask) })}
                    />
                    <span>
                      {MASK_LABEL[mask]} <span className="text-muted-foreground text-xs">· {MASK_HINT[mask]}</span>
                    </span>
                  </label>
                ))}
                <p
                  className={errors.masks ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
                  id={`${ids}-masks-hint`}
                  role={errors.masks ? 'alert' : undefined}
                >
                  {errors.masks ??
                    'Each delivery, retry and test ping hides the chosen fields as described above (emptied, or a stable hash for actor email), and the filter cannot use them.'}
                </p>
              </fieldset>
            </div>
          </div>
          {endpoint ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <Label className="flex flex-col items-start gap-0.5" htmlFor={`${ids}-enabled`}>
                <span>Send events</span>
                <span className="font-normal text-muted-foreground text-xs">Off pauses delivery. Turning it on resumes where it stopped.</span>
              </Label>
              <Switch checked={form.enabled} id={`${ids}-enabled`} onCheckedChange={(enabled) => set({ enabled })} />
            </div>
          ) : null}
          {errors.form ? (
            <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" role="alert">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              {errors.form}
            </p>
          ) : null}
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={save.isPending} type="submit">
              {save.isPending ? <Loader2Icon className="animate-spin" /> : null}
              {retrying ? 'Busy, retrying…' : endpoint ? 'Save' : 'Add endpoint'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RotateDialog({
  projectId,
  endpoint,
  onClose,
  onSecret,
}: {
  projectId: string;
  endpoint: WebhookEndpoint | null;
  onClose: () => void;
  /** The new secret, handed straight to the one-time dialog (never kept in mutation state). */
  onSecret: (issued: Issued) => void;
}) {
  const ids = useId();
  const queryClient = useQueryClient();
  const [overlap, setOverlap] = useState<number>(86_400);
  // Each endpoint starts at the recommended overlap, not at the last one picked for another.
  const [shownFor, setShownFor] = useState<WebhookEndpoint | null>(null);
  // Each opening and closing starts a new session (reopening for the same endpoint too): a rotation from an earlier
  // session neither retries nor closes the dialog showing now.
  const session = useRef(0);
  if (endpoint !== shownFor) {
    setShownFor(endpoint);
    session.current += 1;
    if (endpoint) setOverlap(86_400);
  }
  const onSecretRef = useRef(onSecret);
  onSecretRef.current = onSecret;
  const rotate = useMutation({
    gcTime: 0,
    mutationFn: async ({ e, seconds, at }: { e: WebhookEndpoint; seconds: number; at: number }) => {
      // A retry after the dialog was cancelled does not rotate again (with no overlap it would retire the old secret).
      if (at !== session.current) throw new SaveAbandoned();
      const { secret } = await api.webhooks.rotateSecret(projectId, e.id, seconds);
      // Rotated: the new secret is shown whatever happened to this dialog meanwhile, and never enters mutation state.
      onSecretRef.current({ endpoint: e, secret, overlapSeconds: seconds });
      return e.id;
    },
    ...webhookRetry,
    // Close only the opening that asked, never one opened since (for this endpoint or another).
    onSuccess: (_id, { at }) => {
      // The endpoint's signing warning can clear after a rotation with no overlap.
      queryClient.invalidateQueries({ queryKey: [...queryKeys.project(projectId), 'webhooks'] });
      if (at === session.current) onClose();
    },
    onError: (error, { at }) => {
      if (error instanceof SaveAbandoned || at !== session.current) return;
      toast.error('Could not rotate the secret', { description: webhookErrorCopy(error) });
    },
  });
  const retrying = rotate.isPending && rotate.failureCount > 0 && isWebhookBusy(rotate.failureReason);
  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open={Boolean(endpoint)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Rotate the signing secret</DialogTitle>
          <DialogDescription>
            A new secret signs every delivery from now on. During the overlap the old one signs too, so your receiver keeps verifying while you deploy
            the new one.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <p className="font-medium text-sm" id={`${ids}-overlap`}>
            Overlap
          </p>
          <RadioGroup aria-labelledby={`${ids}-overlap`} className="grid gap-2" onValueChange={(v) => setOverlap(Number(v))} value={String(overlap)}>
            {OVERLAP_CHOICES.map((choice) => (
              <RadioChoice key={choice.seconds} value={String(choice.seconds)}>
                <span className="font-medium text-sm">{choice.label}</span>
                <span className="text-muted-foreground text-xs">{choice.detail}</span>
              </RadioChoice>
            ))}
          </RadioGroup>
        </div>
        <DialogFooter>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={rotate.isPending || !endpoint}
            onClick={() => endpoint && rotate.mutate({ e: endpoint, seconds: overlap, at: session.current })}
          >
            {rotate.isPending ? <Loader2Icon className="animate-spin" /> : null}
            {retrying ? 'Busy, retrying…' : 'Rotate secret'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SecretDialog({ issued, onClose }: { issued: Issued | null; onClose: () => void }) {
  const guard = useSecretCloseGuard(Boolean(issued));
  const close = () => {
    guard.reset();
    onClose();
  };
  const overlap = issued?.overlapSeconds ? OVERLAP_CHOICES.find((c) => c.seconds === issued.overlapSeconds)?.label : null;
  return (
    <Dialog onOpenChange={(next, details) => guard.guard(next, details) && (next ? undefined : close())} open={Boolean(issued)}>
      <DialogContent className="grid-cols-1 sm:max-w-lg [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>{issued?.overlapSeconds === null ? 'Endpoint added: copy its secret' : 'New secret: copy it now'}</DialogTitle>
          <DialogDescription>
            Your receiver verifies each delivery’s <code className="font-mono">webhook-signature</code> header with this secret (Standard Webhooks).
            Logbird shows it once.
          </DialogDescription>
        </DialogHeader>
        {issued ? (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border bg-muted/40 py-1.5 ps-3 pe-1.5">
              <code className="min-w-0 flex-1 basis-40 truncate font-mono text-[13px]" data-testid="one-time-secret">
                {issued.secret}
              </code>
              <CopyButton label="Copy secret" onCopied={guard.markCopied} showLabel value={issued.secret} variant="outline" />
            </div>
            <p className="text-muted-foreground text-xs">
              {issued.overlapSeconds === null
                ? 'Store it in your secrets manager. If it is lost, rotate the secret to get a new one.'
                : issued.overlapSeconds === 0
                  ? 'The old secret has stopped signing. Deploy this one to your receiver now.'
                  : `The old secret also signs deliveries for ${overlap ?? 'the overlap'}. Deploy this one before then.`}
            </p>
          </>
        ) : null}
        {guard.confirming ? (
          <CloseWithoutCopying
            consequence="You won’t see this secret again: you would have to rotate it to get a new one."
            onClose={close}
            onKeep={guard.cancelConfirm}
          />
        ) : (
          <DialogFooter>
            <Button className="whitespace-normal" onClick={close}>
              I have stored the secret
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
