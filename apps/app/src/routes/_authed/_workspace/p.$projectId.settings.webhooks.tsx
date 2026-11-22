import type { WebhookEndpoint } from '@logbird/contracts';
import { TypePill } from '@logbird/ui/components/badges';
import { CopyButton } from '@logbird/ui/components/copy-button';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
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
import { api } from '@/lib/api/client';
import { ApiRequestError } from '@/lib/api/errors';
import { keys as queryKeys, webhooksQuery } from '@/lib/api/queries';
import { creatorLabel } from '@/lib/events';
import { useOrganization } from '@/lib/organization';
import { useCan } from '@/lib/permissions';
import { queryProblem, queryProblemText, reasonTitle } from '@/lib/query-error';
import {
  disabledCopy,
  displayUrl,
  type Form,
  type FormErrors,
  fieldErrorsFromValidation,
  formFrom,
  isWebhookBusy,
  MAX_WEBHOOK_ENDPOINTS,
  OVERLAP_CHOICES,
  scopeOf,
  scopeSummary,
  validateWebhookForm,
  webhookErrorCopy,
  webhookRetry,
} from '@/lib/webhooks';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/webhooks')({
  head: () => ({ meta: [{ title: 'Webhooks · Logbird' }] }),
  component: WebhooksSettings,
});

type Issued = { endpoint: WebhookEndpoint; secret: string; overlapSeconds: number | null };

function WebhooksSettings() {
  const { projectId } = Route.useParams();
  const can = useCan();
  const list = useQuery({ ...webhooksQuery(projectId), enabled: can.isAdmin });
  const [editing, setEditing] = useState<WebhookEndpoint | 'new' | null>(null);
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
              onClick={() => setEditing('new')}
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
            <Button onClick={() => setEditing('new')} size="sm">
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
                onEdit={() => setEditing(endpoint)}
                onRotate={() => setRotating(endpoint)}
                projectId={projectId}
              />
            ))}
          </ul>
        )}
      </SettingsSection>
      <EndpointDialog
        endpoint={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
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
  return { refresh };
}

function EndpointCard({
  projectId,
  endpoint,
  onEdit,
  onRotate,
}: {
  projectId: string;
  endpoint: WebhookEndpoint;
  onEdit: () => void;
  onRotate: () => void;
}) {
  const { refresh } = useEndpointMutations(projectId);
  const confirm = useConfirm();
  const { org } = useOrganization();
  const creator = org.data?.members.find((m) => m.userId === endpoint.createdById)?.user;
  const { host, path } = displayUrl(endpoint.url);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.webhooks.update(projectId, endpoint.id, { enabled }),
    ...webhookRetry,
    onSuccess: (_, enabled) => {
      toast.success(enabled ? 'Endpoint turned on' : 'Endpoint turned off');
      refresh();
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
  const off = !endpoint.enabled;
  const reason = disabledCopy(endpoint.disabledReason);
  const busy = (toggle.isPending && toggle.failureCount > 0) || (remove.isPending && remove.failureCount > 0);
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-lg border p-4" data-testid="webhook-endpoint">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="truncate font-mono text-sm">
            {host}
            <span className="text-muted-foreground">{path}</span>
          </p>
          {endpoint.description ? <p className="text-muted-foreground text-sm">{endpoint.description}</p> : null}
        </div>
        <TypePill tone={off ? 'warning' : 'brand'}>{off ? 'Off' : 'On'}</TypePill>
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
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Sends</dt>
        <dd className="min-w-0">
          {endpoint.filterQuery ? <code className="break-all font-mono text-xs">{endpoint.filterQuery}</code> : 'Every event'}
          {' · '}
          {scopeSummary(endpoint.scope)}
        </dd>
        <dt className="text-muted-foreground">Created</dt>
        <dd>
          <Timestamp format="date" iso={endpoint.createdAt} />
          {creatorLabel(creator) ? ` by ${creatorLabel(creator)}` : endpoint.createdById && org.data ? ' by a former member' : ''}
        </dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onEdit} size="sm" variant="outline">
          Edit
        </Button>
        <Button onClick={onRotate} size="sm" variant="outline">
          Rotate secret
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
    </li>
  );
}

/** A save from an earlier opening of the dialog: dropped, never retried. */
class SaveAbandoned extends Error {}

function EndpointDialog({
  projectId,
  endpoint,
  open,
  onClose,
  onSecret,
}: {
  projectId: string;
  endpoint: WebhookEndpoint | null;
  open: boolean;
  onClose: () => void;
  /** A created endpoint's secret, handed straight to the one-time dialog (never kept in mutation state). */
  onSecret: (issued: Issued) => void;
}) {
  const { refresh } = useEndpointMutations(projectId);
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
      setErrors({});
      setNarrowOpen(Boolean(endpoint?.scope));
    }
  }
  // Every opening and closing starts a new session: a save still retrying from an earlier one stops instead of
  // applying its form to whatever the dialog shows now.
  const session = useRef(0);
  if (open !== wasOpen) session.current += 1;
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
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
        });
        // The endpoint exists now, so its secret is shown whatever happened to this form meanwhile (closed, reopened).
        // It goes straight to the one-time dialog and never enters the mutation's state.
        onSecretRef.current({ endpoint: result.endpoint, secret: result.secret, overlapSeconds: null });
        return { created: result.endpoint };
      }
      const before = formFrom(target);
      const body: Record<string, unknown> = {};
      // Only what changed: a changed URL is checked again (DNS); an unchanged one is not.
      if (f.url.trim() !== before.url) body.url = f.url.trim();
      if (f.description.trim() !== before.description) body.description = f.description.trim() || null;
      if (f.filter.trim() !== before.filter) body.filterQuery = f.filter.trim();
      if (JSON.stringify(scope) !== JSON.stringify(scopeOf(before))) body.scope = scope;
      if (f.enabled !== before.enabled) body.enabled = f.enabled;
      if (!Object.keys(body).length) return null;
      return api.webhooks.update(projectId, target.id, body);
    },
    ...webhookRetry,
    onSuccess: (result, { at }) => {
      refresh();
      if (at !== session.current) return;
      if (!(result && 'created' in result)) toast.success(result ? 'Endpoint saved' : 'Nothing to save');
      onClose();
    },
    onError: (error, { f, at }) => {
      if (error instanceof SaveAbandoned || at !== session.current) return;
      const problem = queryProblem(error, 'query');
      if (problem) setErrors({ filter: `${reasonTitle(problem.details, problem.code)}: ${queryProblemText(problem, f.filter)}` });
      else if (error instanceof ApiRequestError && error.code === 'webhook_url_not_allowed') setErrors({ url: webhookErrorCopy(error) });
      else {
        // A body the contract rejects names its field: put the message there.
        const onField = fieldErrorsFromValidation(error);
        setErrors(Object.keys(onField).length ? onField : { form: webhookErrorCopy(error) });
        if (onField.tenantId || onField.targetType || onField.targetId) setNarrowOpen(true);
      }
    },
  });
  const submit = () => {
    const next = validateWebhookForm(form);
    setErrors(next);
    if (Object.keys(next).length) {
      if (next.tenantId || next.targetType || next.targetId) setNarrowOpen(true);
      return;
    }
    save.mutate({ f: form, target: endpoint, at: session.current });
  };
  const retrying = save.isPending && save.failureCount > 0 && isWebhookBusy(save.failureReason);
  const scopeInvalid = Boolean(errors.tenantId || errors.targetType || errors.targetId);
  const narrowShown = narrowOpen || scopeInvalid;
  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open={open}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{endpoint ? 'Edit endpoint' : 'Add a webhook endpoint'}</DialogTitle>
          <DialogDescription>
            {endpoint
              ? 'Changes apply to every delivery attempt that starts after you save, retries included.'
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
            limits="The query language you use in the explorer, up to 4,096 characters. It is checked when you save, and it cannot use a field the endpoint’s scope hides."
            multiline
            onChange={(filter) => set({ filter })}
            optional
            placeholder="action:booking.* outcome:failure"
            purpose="Which events to send. Empty sends every event."
            value={form.filter}
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
                Only part of the project <span className="font-normal text-muted-foreground">· one tenant or one record</span>
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
  const [overlap, setOverlap] = useState<number>(86_400);
  // Each endpoint starts at the recommended overlap, not at the last one picked for another.
  const [shownFor, setShownFor] = useState<WebhookEndpoint | null>(null);
  if (endpoint !== shownFor) {
    setShownFor(endpoint);
    if (endpoint) setOverlap(86_400);
  }
  const onSecretRef = useRef(onSecret);
  onSecretRef.current = onSecret;
  const showing = useRef(endpoint);
  showing.current = endpoint;
  const rotate = useMutation({
    gcTime: 0,
    mutationFn: async ({ e, seconds }: { e: WebhookEndpoint; seconds: number }) => {
      const { secret } = await api.webhooks.rotateSecret(projectId, e.id, seconds);
      // Rotated: the new secret is shown whatever happened to this dialog meanwhile, and never enters mutation state.
      onSecretRef.current({ endpoint: e, secret, overlapSeconds: seconds });
      return e.id;
    },
    ...webhookRetry,
    // Close only the dialog that asked (not one since opened for another endpoint).
    onSuccess: (id) => {
      if (showing.current?.id === id) onClose();
    },
    onError: (error) => toast.error('Could not rotate the secret', { description: webhookErrorCopy(error) }),
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
          <Button disabled={rotate.isPending || !endpoint} onClick={() => endpoint && rotate.mutate({ e: endpoint, seconds: overlap })}>
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
