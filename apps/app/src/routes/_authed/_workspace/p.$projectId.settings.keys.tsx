import type { ApiKey } from '@logbird/contracts';
import { TypePill } from '@logbird/ui/components/badges';
import { CodeBlock } from '@logbird/ui/components/code-block';
import { CopyButton } from '@logbird/ui/components/copy-button';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { useConfirm } from '@logbird/ui/components/ui/confirm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@logbird/ui/components/ui/dialog';
import { Input } from '@logbird/ui/components/ui/input';
import { Label } from '@logbird/ui/components/ui/label';
import { RadioChoice, RadioGroup } from '@logbird/ui/components/ui/radio-group';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@logbird/ui/components/ui/tooltip';
import { cn } from '@logbird/ui/lib/utils';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { CheckCircle2Icon, KeyRoundIcon, Loader2Icon, PlusIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { type ComponentProps, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { AdminNote, AdminOnly } from '@/components/admin-gate';
import { CloseWithoutCopying, useSecretCloseGuard } from '@/components/one-time-secret';
import { SettingsSection } from '@/components/settings-section';
import { Timestamp } from '@/components/timestamp';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { keysQuery, keys as queryKeys } from '@/lib/api/queries';
import { creatorLabel } from '@/lib/events';
import { fieldErrorMessage } from '@/lib/forms';
import { useCan } from '@/lib/permissions';
import { placeholderKeys } from '@/lib/placeholders';
import { curlSnippet, readCurlSnippet } from '@/lib/snippets';
import { describeUserAgent } from '@/lib/user-agent';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/keys')({
  head: () => ({ meta: [{ title: 'API keys · Settings · Logbird' }] }),
  staticData: { crumb: 'API keys' },
  loader: ({ context, params }) => context.queryClient.prefetchQuery(keysQuery(params.projectId)),
  component: KeysSettings,
});

const KIND_COPY = {
  ingest: { label: 'Ingest', hint: 'Can only send events (POST /v1/events). Use in your services.', short: 'sends events only' },
  read: { label: 'Read', hint: 'Can only search and read events (GET /v1/events). Use in products that show history.', short: 'reads events only' },
} as const;

function KeysSettings() {
  const { projectId } = Route.useParams();
  const list = useQuery(keysQuery(projectId));
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null);
  /** A key just rolled: its replacement's secret is shown once in the same dialog as a newly created key. */
  const [rolled, setRolled] = useState<{ key: ApiKey; secret: string } | null>(null);
  const can = useCan();
  const manage = can('keys.manage');
  const revoke = useMutation({
    mutationFn: (key: ApiKey) => api.keys.revoke(projectId, key.id),
    onSuccess: (_, key) => {
      queryClient.invalidateQueries({ queryKey: [...queryKeys.project(projectId), 'keys'] });
      toast.success(`Revoked “${key.name}”`, { description: 'Requests using it now fail with 401.' });
    },
    onError: (error) => toast.error('Could not revoke the key', { description: errorMessage(error) }),
  });
  const roll = useMutation({
    mutationFn: (key: ApiKey) => api.keys.roll(projectId, key.id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: [...queryKeys.project(projectId), 'keys'] });
      setRolled(result);
      setCreateOpen(true);
    },
    onError: (error) => toast.error('Could not roll the key', { description: errorMessage(error) }),
  });
  const active = list.data?.filter((k) => !k.revokedAt) ?? [];
  const revoked = list.data?.filter((k) => k.revokedAt) ?? [];
  const byId = new Map((list.data ?? []).map((k) => [k.id, k]));
  /** The active key that replaced `key` through a roll, if any. */
  const replacementOf = (key: ApiKey) => active.find((k) => k.replacesKeyId === key.id);

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection
        description="Keys are bound to this project. Logbird stores only a hash and the prefix shown here — the full secret is displayed once, when you create or roll it. To rotate a key: roll it, deploy the new secret, check that the old key's last use stops, then revoke the old key."
        title="API keys"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          {manage ? null : <AdminNote className="flex-1">You can see this project's keys. Owners and admins create and revoke them.</AdminNote>}
          <AdminOnly allowed={manage} className="self-end sm:self-auto">
            <Button disabled={!manage} onClick={() => setCreateOpen(true)} ref={createButton} size="sm">
              <PlusIcon />
              Create key
            </Button>
          </AdminOnly>
        </div>
        {list.isPending ? (
          <div className="flex flex-col gap-2">
            {placeholderKeys(3).map((k) => (
              <Skeleton className="h-14 w-full" key={k} />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} size="sm" />
        ) : list.data.length === 0 ? (
          <EmptyState description="Create an ingest key to start sending events." icon={KeyRoundIcon} size="sm" title="No keys yet" />
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border">
            {[...active, ...revoked].map((k) => {
              const replacement = k.revokedAt ? undefined : replacementOf(k);
              const replaces = k.replacesKeyId ? byId.get(k.replacesKeyId) : undefined;
              const client = describeUserAgent(k.lastUsedUserAgent);
              return (
                <li
                  className={cn('flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4', k.revokedAt && 'bg-muted/30')}
                  data-key-id={k.id}
                  data-testid="api-key-row"
                  key={k.id}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn('truncate font-medium text-sm', k.revokedAt && 'text-muted-foreground line-through')}>{k.name}</span>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              aria-label={`${k.kind} key: ${KIND_COPY[k.kind].hint}`}
                              className="cursor-default rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                              type="button"
                            />
                          }
                        >
                          <TypePill tone={k.kind === 'ingest' ? 'brand' : 'neutral'}>{k.kind}</TypePill>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-64">{KIND_COPY[k.kind].hint}</TooltipContent>
                      </Tooltip>
                      {k.revokedAt ? (
                        <TypePill tone="warning">
                          revoked <Timestamp format="relative" iso={k.revokedAt} />
                        </TypePill>
                      ) : replacement ? (
                        <TypePill tone="warning">replaced · still valid</TypePill>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground text-xs">
                      <span className="font-mono">{k.prefix}••••••••</span>
                      <span>{KIND_COPY[k.kind].short}</span>
                      <span>
                        Created <Timestamp format="date" iso={k.createdAt} />
                        {creatorLabel(k.createdBy) ? ` by ${creatorLabel(k.createdBy)}` : ''}
                      </span>
                      {replaces ? (
                        <span>
                          Replaces <span className="font-mono">{replaces.prefix}…</span>
                        </span>
                      ) : null}
                      {replacement ? (
                        <span className="text-foreground">
                          Replaced by <span className="font-mono">{replacement.prefix}…</span> — revoke this key once nothing uses it
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 sm:justify-end">
                    <span className="text-muted-foreground text-xs" data-testid="key-last-used" title={k.lastUsedUserAgent ?? undefined}>
                      {k.lastUsedAt ? (
                        <>
                          Last used <Timestamp className="text-foreground" fallback="never" format="relative" iso={k.lastUsedAt} />
                          {client ? (
                            <>
                              {' '}
                              by <span className="font-mono text-foreground">{client}</span>
                            </>
                          ) : null}
                        </>
                      ) : (
                        'Never used'
                      )}
                    </span>
                    {k.revokedAt || !manage ? null : (
                      <span className="ms-auto flex items-center gap-1">
                        {replacement ? null : (
                          <Button
                            data-testid="roll-key"
                            disabled={roll.isPending}
                            onClick={async () => {
                              const ok = await confirm({
                                title: `Roll “${k.name}”?`,
                                description: `Logbird creates a new ${k.kind} key named “${k.name}” and shows its secret once. ${k.prefix}… keeps working until you revoke it: deploy the new key, check that the old one is no longer used, then revoke it here.`,
                                confirmLabel: 'Roll key',
                              });
                              if (ok) roll.mutate(k);
                            }}
                            size="sm"
                            variant="ghost"
                          >
                            {roll.isPending && roll.variables?.id === k.id ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                            Roll
                          </Button>
                        )}
                        <Button
                          className="text-destructive hover:text-destructive"
                          data-testid={replacement ? 'revoke-old-key' : 'revoke-key'}
                          disabled={revoke.isPending && revoke.variables?.id === k.id}
                          onClick={async () => {
                            const lastUse = k.lastUsedAt
                              ? `It was last used ${new Date(k.lastUsedAt).toLocaleString()}${client ? ` by ${client}` : ''}. `
                              : 'It was never used. ';
                            const ok = await confirm({
                              title: replacement ? `Revoke the old “${k.name}” key?` : `Revoke “${k.name}”?`,
                              description: `${lastUse}Anything using ${k.prefix}… stops working immediately${k.kind === 'ingest' ? ' and its events are rejected' : ''}. This cannot be undone.`,
                              confirmLabel: replacement ? 'Revoke old key' : 'Revoke key',
                              destructive: true,
                            });
                            if (ok) revoke.mutate(k);
                          }}
                          size="sm"
                          variant={replacement ? 'outline' : 'ghost'}
                        >
                          {replacement ? 'Revoke old key' : 'Revoke'}
                        </Button>
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsSection>
      {manage ? (
        <CreateKeyDialog
          finalFocus={() =>
            // After a roll the next step is revoking the old key once nothing uses it: land on that button.
            (rolled?.key.replacesKeyId
              ? document.querySelector<HTMLElement>(`[data-key-id="${rolled.key.replacesKeyId}"] [data-testid="revoke-old-key"]`)
              : null) ?? createButton.current
          }
          onClosed={() => setRolled(null)}
          onOpenChange={setCreateOpen}
          open={createOpen}
          projectId={projectId}
          rolled={rolled}
        />
      ) : null}
    </div>
  );
}

const nameSchema = z.string().trim().min(1, 'Name the key after what will use it.').max(64);

function CreateKeyDialog({
  open,
  onOpenChange,
  projectId,
  finalFocus,
  rolled,
  onClosed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The "Create key" button: the dialog opens from state, so it returns focus there explicitly. */
  finalFocus: ComponentProps<typeof DialogContent>['finalFocus'];
  /** Set when the dialog opens to show a rolled key's replacement secret instead of the create form. */
  rolled: { key: ApiKey; secret: string } | null;
  onClosed: () => void;
}) {
  const queryClient = useQueryClient();
  const nameInput = useRef<HTMLInputElement>(null);
  const kindLabel = useId();
  const [createdHere, setCreated] = useState<{ key: ApiKey; secret: string } | null>(null);
  const created = rolled ?? createdHere;
  const secretGuard = useSecretCloseGuard(Boolean(created));
  const create = useMutation({
    mutationFn: (value: { name: string; kind: 'ingest' | 'read' }) => api.keys.create(projectId, { name: value.name.trim(), kind: value.kind }),
    onSuccess: (result) => {
      setCreated(result);
      queryClient.invalidateQueries({ queryKey: [...queryKeys.project(projectId), 'keys'] });
    },
  });
  const form = useForm({
    defaultValues: { name: '', kind: 'ingest' as 'ingest' | 'read' },
    onSubmit: async ({ value }) => {
      await create.mutateAsync(value).catch(() => undefined);
    },
  });
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setTimeout(() => {
        setCreated(null);
        onClosed();
        secretGuard.reset();
        form.reset();
        create.reset();
      }, 200);
    }
  };

  return (
    // Escape, a backdrop tap or the corner × never discard an uncopied secret: the dialog asks first (OWNER-10).
    <Dialog onOpenChange={(next, details) => secretGuard.guard(next, details) && close(next)} open={open}>
      <DialogContent
        // Phones: the secret, its snippet and the close confirmation can be taller than the screen — scroll inside,
        // vertically only (min-w-0 columns keep the wide snippet from pushing the dialog sideways).
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto overflow-x-hidden sm:max-w-lg"
        finalFocus={finalFocus}
        initialFocus={created ? undefined : nameInput}
      >
        {created ? (
          <div className="flex min-w-0 flex-col gap-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2Icon className="size-5 text-outcome-success" />
                {rolled ? 'Key rolled' : 'Key created'}
              </DialogTitle>
              <DialogDescription>
                Copy it now — this is the only time Logbird shows the full secret.
                {rolled ? ' The old key keeps working until you revoke it, so deploy this one first.' : ''}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 py-1.5 ps-3 pe-1.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[13px]" data-testid="one-time-secret">
                {created.secret}
              </code>
              <CopyButton label="Copy key" onCopied={secretGuard.markCopied} showLabel value={created.secret} variant="outline" />
            </div>
            <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
              <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-outcome-denied" />
              Store it in your secrets manager. If it is lost, revoke it and create a new one.
            </p>
            <CodeBlock
              code={created.key.kind === 'ingest' ? curlSnippet(created.secret) : readCurlSnippet(created.secret)}
              language="bash"
              maxHeight={220}
              onCopied={secretGuard.markCopied}
            />
            {secretGuard.confirming ? (
              <CloseWithoutCopying onClose={() => close(false)} onKeep={secretGuard.cancelConfirm} />
            ) : (
              <DialogFooter>
                <Button onClick={() => close(false)}>I have stored the key</Button>
              </DialogFooter>
            )}
          </div>
        ) : (
          <form
            className="flex min-w-0 flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              form.handleSubmit();
            }}
          >
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>Keys are scoped to one project and one permission.</DialogDescription>
            </DialogHeader>
            <form.Field name="name" validators={{ onSubmit: nameSchema }}>
              {(field) => {
                const message = fieldErrorMessage(field.state.meta.errors);
                return (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="key-name">Name</Label>
                    <Input
                      aria-invalid={Boolean(message) || undefined}
                      id="key-name"
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="Production API"
                      ref={nameInput}
                      value={field.state.value}
                    />
                    {message ? <p className="text-destructive text-xs">{message}</p> : null}
                  </div>
                );
              }}
            </form.Field>
            <form.Field name="kind">
              {(field) => (
                <div className="flex flex-col gap-1.5">
                  <Label id={kindLabel}>Permission</Label>
                  <RadioGroup
                    aria-labelledby={kindLabel}
                    className="grid gap-2 sm:grid-cols-2"
                    onValueChange={(kind) => field.handleChange(kind as 'ingest' | 'read')}
                    value={field.state.value}
                  >
                    {(['ingest', 'read'] as const).map((kind) => (
                      <RadioChoice key={kind} value={kind}>
                        <span className="font-medium text-sm">
                          {KIND_COPY[kind].label}
                          <span className="sr-only"> — </span>
                        </span>
                        <span className="text-muted-foreground text-xs">{KIND_COPY[kind].hint}</span>
                      </RadioChoice>
                    ))}
                  </RadioGroup>
                </div>
              )}
            </form.Field>
            {create.isError ? <p className="text-destructive text-sm">{errorMessage(create.error)}</p> : null}
            <DialogFooter>
              <Button onClick={() => close(false)} type="button" variant="outline">
                Cancel
              </Button>
              <form.Subscribe selector={(s) => s.isSubmitting}>
                {(submitting) => (
                  <Button disabled={submitting} type="submit">
                    {submitting ? <Loader2Icon className="animate-spin" /> : null}
                    Create key
                  </Button>
                )}
              </form.Subscribe>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
