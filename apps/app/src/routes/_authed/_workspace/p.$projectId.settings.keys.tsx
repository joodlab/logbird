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
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { cn } from '@logbird/ui/lib/utils';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { CheckCircle2Icon, KeyRoundIcon, Loader2Icon, PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { type RefObject, useRef, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { AdminNote, AdminOnly } from '@/components/admin-gate';
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

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/keys')({
  head: () => ({ meta: [{ title: 'API keys · Settings · Logbird' }] }),
  staticData: { crumb: 'API keys' },
  loader: ({ context, params }) => context.queryClient.prefetchQuery(keysQuery(params.projectId)),
  component: KeysSettings,
});

const KIND_COPY = {
  ingest: { label: 'Ingest', hint: 'Can only send events (POST /v1/events). Use in your services.' },
  read: { label: 'Read', hint: 'Can only search and read events (GET /v1/events). Use in products that show history.' },
} as const;

function KeysSettings() {
  const { projectId } = Route.useParams();
  const list = useQuery(keysQuery(projectId));
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null);
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
  const active = list.data?.filter((k) => !k.revokedAt) ?? [];
  const revoked = list.data?.filter((k) => k.revokedAt) ?? [];

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection
        description="Keys are bound to this project. Logbird stores only a hash and the prefix shown here — the full secret is displayed once, when you create it."
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
            {[...active, ...revoked].map((k) => (
              <li className={cn('flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4', k.revokedAt && 'bg-muted/30')} key={k.id}>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className={cn('truncate font-medium text-sm', k.revokedAt && 'text-muted-foreground line-through')}>{k.name}</span>
                    <TypePill tone={k.kind === 'ingest' ? 'brand' : 'neutral'}>{k.kind}</TypePill>
                    {k.revokedAt ? (
                      <TypePill tone="warning">
                        revoked <Timestamp format="relative" iso={k.revokedAt} />
                      </TypePill>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground text-xs">
                    <span className="font-mono">{k.prefix}••••••••</span>
                    <span>
                      Created <Timestamp format="date" iso={k.createdAt} />
                      {creatorLabel(k.createdBy) ? ` by ${creatorLabel(k.createdBy)}` : ''}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center justify-between gap-4 sm:justify-end">
                  <span className="text-muted-foreground text-xs">
                    {k.lastUsedAt ? (
                      <>
                        Last used <Timestamp className="text-foreground" fallback="never" format="relative" iso={k.lastUsedAt} />
                      </>
                    ) : (
                      'Never used'
                    )}
                  </span>
                  {k.revokedAt || !manage ? null : (
                    <Button
                      className="text-destructive hover:text-destructive"
                      disabled={revoke.isPending && revoke.variables?.id === k.id}
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Revoke “${k.name}”?`,
                          description: `Anything using ${k.prefix}… stops working immediately${k.kind === 'ingest' ? ' and its events are rejected' : ''}. This cannot be undone.`,
                          confirmLabel: 'Revoke key',
                          destructive: true,
                        });
                        if (ok) revoke.mutate(k);
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      {manage ? <CreateKeyDialog finalFocus={createButton} onOpenChange={setCreateOpen} open={createOpen} projectId={projectId} /> : null}
    </div>
  );
}

const nameSchema = z.string().trim().min(1, 'Name the key after what will use it.').max(64);

function CreateKeyDialog({
  open,
  onOpenChange,
  projectId,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The "Create key" button: the dialog opens from state, so it returns focus there explicitly. */
  finalFocus: RefObject<HTMLButtonElement | null>;
}) {
  const queryClient = useQueryClient();
  const nameInput = useRef<HTMLInputElement>(null);
  const [created, setCreated] = useState<{ key: ApiKey; secret: string } | null>(null);
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
        form.reset();
        create.reset();
      }, 200);
    }
  };

  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent className="sm:max-w-lg" finalFocus={finalFocus} initialFocus={created ? undefined : nameInput}>
        {created ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2Icon className="size-5 text-outcome-success" />
                Key created
              </DialogTitle>
              <DialogDescription>Copy it now — this is the only time Logbird shows the full secret.</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 py-1.5 ps-3 pe-1.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{created.secret}</code>
              <CopyButton label="Copy key" showLabel value={created.secret} variant="outline" />
            </div>
            <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
              <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-outcome-denied" />
              Store it in your secrets manager. If it is lost, revoke it and create a new one.
            </p>
            <CodeBlock
              code={created.key.kind === 'ingest' ? curlSnippet(created.secret) : readCurlSnippet(created.secret)}
              language="bash"
              maxHeight={220}
            />
            <DialogFooter>
              <Button onClick={() => close(false)}>I have stored the key</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
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
                  <Label>Permission</Label>
                  <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
                    {(['ingest', 'read'] as const).map((kind) => (
                      // biome-ignore lint/a11y/useSemanticElements: card-style choices; role=radio + aria-checked expose them as a radio group
                      <button
                        aria-checked={field.state.value === kind}
                        className={cn(
                          'flex flex-col items-start gap-1 rounded-lg border p-3 text-start outline-none transition-colors hover:border-foreground/25 focus-visible:ring-3 focus-visible:ring-ring/40',
                          field.state.value === kind && 'border-brand ring-1 ring-brand',
                        )}
                        key={kind}
                        onClick={() => field.handleChange(kind)}
                        role="radio"
                        type="button"
                      >
                        <span className="font-medium text-sm">{KIND_COPY[kind].label}</span>
                        <span className="text-muted-foreground text-xs">{KIND_COPY[kind].hint}</span>
                      </button>
                    ))}
                  </div>
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
