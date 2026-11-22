import { type ApiKey, type ApiKeyKind, SCOPE_MASKS } from '@logbird/contracts';
import { TypePill } from '@logbird/ui/components/badges';
import { CodeBlock } from '@logbird/ui/components/code-block';
import { CopyButton } from '@logbird/ui/components/copy-button';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Button } from '@logbird/ui/components/ui/button';
import { Checkbox } from '@logbird/ui/components/ui/checkbox';
import { useConfirm } from '@logbird/ui/components/ui/confirm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@logbird/ui/components/ui/dialog';
import { Input } from '@logbird/ui/components/ui/input';
import { Label } from '@logbird/ui/components/ui/label';
import { RadioChoice, RadioGroup } from '@logbird/ui/components/ui/radio-group';
import { SegmentedControl, SegmentedControlItem } from '@logbird/ui/components/ui/segmented-control';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { Textarea } from '@logbird/ui/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@logbird/ui/components/ui/tooltip';
import { cn } from '@logbird/ui/lib/utils';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { CheckCircle2Icon, ChevronDownIcon, KeyRoundIcon, Loader2Icon, PlusIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { AdminNote, AdminOnly } from '@/components/admin-gate';
import { KeyGrantSummary, KeyScopeLine, SCOPED_READ_DOCS, ViewerTokenHelp } from '@/components/keys/key-scope';
import { CloseWithoutCopying, useSecretCloseGuard } from '@/components/one-time-secret';
import { SettingsSection } from '@/components/settings-section';
import { Timestamp } from '@/components/timestamp';
import { api } from '@/lib/api/client';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import { keysQuery, keys as queryKeys } from '@/lib/api/queries';
import {
  createKeyBody,
  EMPTY_KEY_FORM,
  type ExpectedGrant,
  expectedFromBody,
  expectedFromRoll,
  expiresSoon,
  expiryFor,
  formScope,
  grantDifferences,
  isKeyExpired,
  isKeyUsable,
  KEY_EXPIRY_PRESETS,
  type KeyExpiryPreset,
  type KeyFormValues,
  MASK_HINT,
  MASK_LABEL,
  ORIGIN_RULE,
  SCOPE_ID_RULE,
  SCOPE_LIMITS,
  validateKeyForm,
} from '@/lib/api-keys';
import { creatorLabel } from '@/lib/events';
import { formatFull } from '@/lib/format';
import { fieldErrorMessage } from '@/lib/forms';
import { useCan } from '@/lib/permissions';
import { placeholderKeys } from '@/lib/placeholders';
import { curlSnippet, readCurlSnippet } from '@/lib/snippets';
import { describeUserAgent } from '@/lib/user-agent';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/keys')({
  head: () => ({ meta: [{ title: 'API keys · Project settings · Logbird' }] }),
  staticData: { crumb: 'API keys' },
  loader: ({ context, params }) => context.queryClient.prefetchQuery(keysQuery(params.projectId)),
  component: KeysSettings,
});

const KIND_COPY = {
  // `hint`: the full sentence (list tooltips); `card`: one short line on the create form's choice cards.
  ingest: {
    label: 'Ingest',
    hint: 'Can only send events (POST /v1/events). Use in your services.',
    card: 'Sends events only. For your services.',
    short: 'sends events only',
  },
  read: {
    label: 'Read',
    hint: 'Reads every event in this project and mints viewer tokens for any tenant. Keep it on your server.',
    card: 'Reads every event. Keep it on your server.',
    short: 'reads every event',
  },
  'scoped-read': {
    label: 'Scoped read',
    hint: 'Reads only one tenant’s events (optionally one target and some actions, with fields hidden). The server enforces it.',
    card: 'Reads one tenant’s events only.',
    short: 'reads one tenant only',
  },
} as const;

/** A secret shown once, with what the server granted and what was asked for. */
type IssuedKey = { key: ApiKey; secret: string; expected: ExpectedGrant /** Rolls: whether the replaced key still worked. */; oldUsable?: boolean };

function KeysSettings() {
  const { projectId } = Route.useParams();
  const list = useQuery(keysQuery(projectId));
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null);
  /** A key just rolled: its replacement's secret is shown once in the same dialog as a newly created key. */
  const [rolled, setRolled] = useState<IssuedKey | null>(null);
  /** The key whose roll dialog is open. */
  const [rolling, setRolling] = useState<ApiKey | null>(null);
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
  const byId = new Map((list.data ?? []).map((k) => [k.id, k]));
  /** The usable key that replaced `key` through a roll, if any (an expired replacement does not count). */
  const replacementOf = (key: ApiKey) => active.find((k) => k.replacesKeyId === key.id && isKeyUsable(k));

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection
        description={
          <>
            Keys are bound to this project. Logbird stores only a hash and the prefix shown here — the full secret is displayed once, when you create
            or roll it. To rotate a key: roll it, deploy the new secret, check that the old key's last use stops, then revoke the old key. To show
            customers only their own events, use a read or scoped read key on your server and{' '}
            <a className="underline underline-offset-2 hover:text-foreground" href={SCOPED_READ_DOCS} rel="noreferrer" target="_blank">
              mint viewer tokens
            </a>{' '}
            for their browsers.
          </>
        }
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
              const expired = !k.revokedAt && isKeyExpired(k);
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
                      ) : expired ? (
                        <TypePill tone="warning">
                          expired <Timestamp format="relative" iso={k.expiresAt} />
                        </TypePill>
                      ) : replacement ? (
                        <TypePill tone="warning">replaced · still valid</TypePill>
                      ) : expiresSoon(k) ? (
                        <TypePill tone="warning">
                          expires <Timestamp format="relative" iso={k.expiresAt} />
                        </TypePill>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground text-xs">
                      <span className="font-mono">{k.prefix}••••••••</span>
                      {k.kind === 'scoped-read' && k.scope ? <KeyScopeLine scope={k.scope} /> : <span>{KIND_COPY[k.kind].short}</span>}
                      {k.embedOrigins.length ? (
                        <span title={k.embedOrigins.join('\n')}>
                          {k.embedOrigins.length === 1 ? (
                            <>
                              tokens work on <span className="font-mono text-foreground">{k.embedOrigins[0]}</span>
                            </>
                          ) : (
                            `tokens work on ${k.embedOrigins.length} origins`
                          )}
                        </span>
                      ) : null}
                      {k.expiresAt && !k.revokedAt && !expired ? (
                        <span>
                          Expires <Timestamp format="date" iso={k.expiresAt} />
                        </span>
                      ) : null}
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
                          <Button data-testid="roll-key" onClick={() => setRolling(k)} size="sm" variant="ghost">
                            <RefreshCwIcon />
                            Roll
                          </Button>
                        )}
                        <Button
                          className="text-destructive hover:text-destructive"
                          data-testid={replacement ? 'revoke-old-key' : 'revoke-key'}
                          disabled={revoke.isPending && revoke.variables?.id === k.id}
                          onClick={async () => {
                            const lastUse = k.lastUsedAt
                              ? `It was last used ${formatFull(k.lastUsedAt)}${client ? ` by ${client}` : ''}. `
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
        <>
          <RollKeyDialog
            apiKey={rolling}
            onClose={() => setRolling(null)}
            onRolled={(issued) => {
              setRolling(null);
              setRolled(issued);
              setCreateOpen(true);
            }}
            projectId={projectId}
          />
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
        </>
      ) : null}
    </div>
  );
}

const nameSchema = z.string().trim().min(1, 'Name the key after what will use it.').max(64);

/** "Expires after" choices; `keep` (rolls only) keeps the old key's expiry. */
function ExpiryChoice<T extends string>({
  label,
  value,
  options,
  onChange,
  note,
}: {
  label: string;
  /** null: nothing chosen yet. */
  value: T | null;
  options: readonly { id: T; label: string }[];
  onChange: (value: T) => void;
  note: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label id={id}>{label}</Label>
      <SegmentedControl aria-labelledby={id} className="flex-wrap" role="group">
        {options.map((o) => (
          <SegmentedControlItem active={value === o.id} key={o.id} onClick={() => onChange(o.id)}>
            {o.label}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      <p className="text-muted-foreground text-xs" data-testid="expiry-note">
        {note}
      </p>
    </div>
  );
}

const expiryNote = (iso: string | undefined) =>
  iso ? (
    <>
      Expires <Timestamp className="text-foreground" format="full" iso={iso} />. Requests and viewer tokens fail after that.
    </>
  ) : (
    'Never expires. Roll or revoke it yourself.'
  );

/** Roll: the replacement keeps the old key's scope and origins; it keeps the old expiry unless a new one is chosen. */
function RollKeyDialog({
  apiKey,
  projectId,
  onClose,
  onRolled,
}: {
  apiKey: ApiKey | null;
  projectId: string;
  onClose: () => void;
  onRolled: (issued: IssuedKey) => void;
}) {
  const queryClient = useQueryClient();
  type RollExpiry = 'keep' | Exclude<KeyExpiryPreset, 'never'>;
  // The choice belongs to one opening of the dialog for one key: another key (or the same key opened again) starts over.
  const [choice, setChoice] = useState<{ keyId: string; value: RollExpiry | null } | null>(null);
  // Set when the key expired while the dialog was open (on Roll, or the server's 409 key_expired).
  const [expiredMeanwhile, setExpiredMeanwhile] = useState<string | null>(null);
  const expired = apiKey ? isKeyExpired(apiKey) || expiredMeanwhile === apiKey.id : false;
  // A usable key defaults to keeping its expiry; an expired key has no default: the reader picks a new expiry.
  const picked = apiKey && choice?.keyId === apiKey.id ? choice.value : null;
  const value: RollExpiry | null = picked === 'keep' && expired ? null : (picked ?? (expired ? null : 'keep'));
  const reset = () => {
    setChoice(null);
    setExpiredMeanwhile(null);
  };
  const roll = useMutation({
    mutationFn: async ({ key, expiry, oldUsable }: { key: ApiKey; expiry: RollExpiry; oldUsable: boolean }) => {
      const expiresAt = expiry === 'keep' ? undefined : expiryFor(expiry);
      const result = await api.keys.roll(projectId, key.id, expiresAt ? { expiresAt } : {});
      // Whether the old key still worked, as the dialog knew it (including a server-confirmed expiry the browser's clock missed).
      // Still usable when the answer arrives (it can expire while the roll is in flight), and as the dialog knew it at the
      // click (including a server-confirmed expiry the browser's clock missed).
      return { ...result, expected: expectedFromRoll(key, expiresAt), oldUsable: oldUsable && isKeyUsable(key) };
    },
    onSuccess: (issued) => {
      queryClient.invalidateQueries({ queryKey: [...queryKeys.project(projectId), 'keys'] });
      reset();
      onRolled(issued);
    },
    onError: (error, { key }) => {
      // It expired between the click and the server: ask for a new expiry instead of failing with a code.
      if (error instanceof ApiRequestError && error.code === 'key_expired') {
        setExpiredMeanwhile(key.id);
        roll.reset();
      }
    },
  });
  const close = () => {
    reset();
    // A roll already sent keeps its pending state, so reopening cannot send a second one; its secret still shows on success.
    if (!roll.isPending) roll.reset();
    onClose();
  };
  const options: { id: RollExpiry; label: string }[] = [
    ...(expired ? [] : [{ id: 'keep' as const, label: 'Same as now' }]),
    ...KEY_EXPIRY_PRESETS.filter((p) => p.id !== 'never').map((p) => ({ id: p.id as RollExpiry, label: `In ${p.label}` })),
  ];
  const note =
    value === null
      ? 'Choose when the new key expires.'
      : value === 'keep'
        ? apiKey?.expiresAt
          ? expiryNote(apiKey.expiresAt)
          : 'Never expires, like the key it replaces.'
        : expiryNote(expiryFor(value));
  return (
    <Dialog onOpenChange={(open) => (open ? undefined : close())} open={Boolean(apiKey)}>
      {/* Short phone screens: the expiry choices and Roll stay reachable by scrolling inside the dialog. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overflow-x-hidden sm:max-w-md">
        {apiKey ? (
          <div className="flex min-w-0 flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Roll “{apiKey.name}”?</DialogTitle>
              <DialogDescription>
                Logbird creates a new {apiKey.kind} key named “{apiKey.name}”{apiKey.scope ? ' with the same scope' : ''}
                {apiKey.embedOrigins.length ? ' and browser origins' : ''} and shows its secret once.{' '}
                {expired
                  ? `${apiKey.prefix}… has expired and no longer works: deploy the new key in its place.`
                  : `${apiKey.prefix}… keeps working until you revoke it: deploy the new key, check that the old one is no longer used, then revoke it here.`}
              </DialogDescription>
            </DialogHeader>
            {expired ? (
              <p className="flex items-start gap-1.5 text-xs" role="status">
                <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-outcome-denied" />
                <span>
                  This key expired <Timestamp format="relative" iso={apiKey.expiresAt} />. Its replacement needs a new expiry.
                </span>
              </p>
            ) : null}
            <ExpiryChoice
              label="The new key expires"
              note={note}
              onChange={(next) => setChoice({ keyId: apiKey.id, value: next })}
              options={options}
              value={value}
            />
            {/* Only this key's own roll: a roll for another key that was cancelled while in flight reports nothing here. */}
            {roll.isError && roll.variables?.key.id === apiKey.id ? <p className="text-destructive text-sm">{errorMessage(roll.error)}</p> : null}
            <DialogFooter>
              <Button onClick={close} type="button" variant="outline">
                Cancel
              </Button>
              <Button
                data-testid="confirm-roll"
                disabled={roll.isPending || value === null}
                onClick={() => {
                  // Recheck at the click: a key that expired while the dialog was open cannot keep its expiry.
                  if (value === 'keep' && isKeyExpired(apiKey)) {
                    setExpiredMeanwhile(apiKey.id);
                    return;
                  }
                  if (value) roll.mutate({ key: apiKey, expiry: value, oldUsable: !expired && isKeyUsable(apiKey) });
                }}
              >
                {roll.isPending && roll.variables?.key.id === apiKey.id ? <Loader2Icon className="animate-spin" /> : null}
                Roll key
              </Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The line under a field: its short purpose by default, its limits while it is focused, its error once invalid. The
 * limits stay in the field's accessible description throughout (visually hidden when not shown), so a screen reader
 * hears them on focus; the dialog stays short until someone is filling a field in.
 */
function FieldHint({
  id,
  purpose,
  limits,
  error,
  focused,
}: {
  id: string;
  purpose?: ReactNode;
  limits: ReactNode;
  error?: string;
  focused: boolean;
}) {
  return (
    <>
      {error ? (
        <p className="text-destructive text-xs" id={`${id}-hint`}>
          {error}
        </p>
      ) : purpose ? (
        // Hidden visually (not removed) while the limits show, so the field's description never points at nothing.
        <p className={focused ? 'sr-only' : 'text-muted-foreground text-xs'} id={`${id}-hint`}>
          {purpose}
        </p>
      ) : null}
      <p className={focused && !error ? 'text-muted-foreground text-xs' : 'sr-only'} id={`${id}-limits`}>
        {limits}
      </p>
    </>
  );
}
/** The field's description: its hint line when it has one (purpose or error), and its limits. */
const describedBy = (id: string, hasHint = true) => (hasHint ? `${id}-hint ${id}-limits` : `${id}-limits`);

/** A labelled text field with its purpose, its limits while focused, and its error (see `FieldHint`). */
function TextField({
  id,
  label,
  optional,
  purpose,
  limits,
  error,
  multiline,
  ...props
}: {
  id: string;
  label: string;
  optional?: boolean;
  purpose?: ReactNode;
  limits: ReactNode;
  error: string | undefined;
  multiline?: boolean;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const common = {
    'aria-describedby': describedBy(id, Boolean(error || purpose)),
    'aria-invalid': Boolean(error) || undefined,
    autoCapitalize: 'off',
    autoComplete: 'off',
    className: 'font-mono',
    id,
    onBlur: () => setFocused(false),
    onChange: (e: { target: { value: string } }) => props.onChange(e.target.value),
    onFocus: () => setFocused(true),
    placeholder: props.placeholder,
    spellCheck: false,
    value: props.value,
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {optional ? <span className="font-normal text-muted-foreground"> · optional</span> : null}
      </Label>
      {multiline ? <Textarea {...common} rows={2} /> : <Input {...common} />}
      <FieldHint error={error} focused={focused} id={id} limits={limits} purpose={purpose} />
    </div>
  );
}

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
  rolled: IssuedKey | null;
  onClosed: () => void;
}) {
  const queryClient = useQueryClient();
  const nameInput = useRef<HTMLInputElement>(null);
  const [nameFocused, setNameFocused] = useState(false);
  const [narrowOpen, setNarrowOpen] = useState(false);
  const ids = useId();
  const [createdHere, setCreated] = useState<IssuedKey | null>(null);
  const created = rolled ?? createdHere;
  const secretGuard = useSecretCloseGuard(Boolean(created));
  const create = useMutation({
    mutationFn: async (value: KeyFormValues) => {
      const body = createKeyBody(value);
      const result = await api.keys.create(projectId, body);
      return { ...result, expected: expectedFromBody(body) };
    },
    onSuccess: (result) => {
      setCreated(result);
      queryClient.invalidateQueries({ queryKey: [...queryKeys.project(projectId), 'keys'] });
    },
  });
  const form = useForm({
    defaultValues: EMPTY_KEY_FORM,
    validators: {
      onSubmit: ({ value }) => {
        const fields = validateKeyForm(value);
        return Object.keys(fields).length ? { fields } : undefined;
      },
    },
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
  const differences = created ? grantDifferences(created.expected, created.key) : [];

  return (
    // Escape, a backdrop tap or the corner × never discard an uncopied secret: the dialog asks first (OWNER-10).
    <Dialog onOpenChange={(next, details) => secretGuard.guard(next, details) && close(next)} open={open}>
      <DialogContent
        // Phones: the secret, its snippet and the close confirmation can be taller than the screen — scroll inside,
        // vertically only (min-w-0 columns keep the wide snippet from pushing the dialog sideways).
        className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto overflow-x-hidden sm:max-w-xl"
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
                {rolled
                  ? rolled.oldUsable === false
                    ? ' The key it replaces had already expired: deploy this one in its place.'
                    : ' The old key keeps working until you revoke it, so deploy this one first.'
                  : ''}
              </DialogDescription>
            </DialogHeader>
            {differences.length ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm" role="alert">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                <span>
                  The server returned a key with a different {differences.join(', ')} than you asked for (an older Logbird server ignores some of
                  these settings). Do not use this secret: revoke the key, then try again once the server is updated.
                </span>
              </div>
            ) : null}
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
            {/* What the server granted, from its response: never from what the form asked for. */}
            <KeyGrantSummary
              embedOrigins={created.key.embedOrigins}
              expiresAt={created.key.expiresAt}
              kind={created.key.kind}
              scope={created.key.scope}
              title="What this key can do (as the server granted it)"
            />
            <CodeBlock
              code={created.key.kind === 'ingest' ? curlSnippet(created.secret) : readCurlSnippet(created.secret)}
              language="bash"
              maxHeight={220}
              onCopied={secretGuard.markCopied}
            />
            {created.key.kind === 'ingest' ? null : (
              <ViewerTokenHelp onCopied={secretGuard.markCopied} scope={created.key.scope} secret={created.secret} />
            )}
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
              <DialogDescription>Keys belong to one project. Choose what this one may do; it cannot be changed later.</DialogDescription>
            </DialogHeader>
            <form.Field name="name" validators={{ onSubmit: nameSchema }}>
              {(field) => {
                const message = fieldErrorMessage(field.state.meta.errors);
                return (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="key-name">Name</Label>
                    <Input
                      aria-describedby={describedBy('key-name')}
                      aria-invalid={Boolean(message) || undefined}
                      id="key-name"
                      onBlur={() => setNameFocused(false)}
                      onFocus={() => setNameFocused(true)}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="Production API"
                      ref={nameInput}
                      value={field.state.value}
                    />
                    <FieldHint
                      error={message}
                      focused={nameFocused}
                      id="key-name"
                      limits="Up to 64 characters."
                      purpose="Name it after what will use it."
                    />
                  </div>
                );
              }}
            </form.Field>
            <form.Field name="kind">
              {(field) => (
                <div className="flex flex-col gap-1.5">
                  <Label id={`${ids}-kind`}>Permission</Label>
                  <RadioGroup
                    aria-labelledby={`${ids}-kind`}
                    className="grid gap-2 sm:grid-cols-3"
                    onValueChange={(kind) => field.handleChange(kind as ApiKeyKind)}
                    value={field.state.value}
                  >
                    {(['ingest', 'read', 'scoped-read'] as const).map((kind) => (
                      <RadioChoice data-testid={`kind-${kind}`} key={kind} value={kind}>
                        <span className="font-medium text-sm">
                          {KIND_COPY[kind].label}
                          <span className="sr-only"> — </span>
                        </span>
                        <span className="text-muted-foreground text-xs">{KIND_COPY[kind].card}</span>
                      </RadioChoice>
                    ))}
                  </RadioGroup>
                </div>
              )}
            </form.Field>
            <form.Subscribe selector={(s) => s.values.kind}>
              {(kind) =>
                kind === 'scoped-read' ? (
                  <fieldset className="flex min-w-0 flex-col gap-3 rounded-lg border p-3">
                    <legend className="px-1 font-medium text-sm">What it can read</legend>
                    <p className="-mt-1 text-muted-foreground text-xs">
                      Ids exactly as stored, as on a tenant’s page. The API enforces the scope on every read (and the database the tenant, when the
                      restricted query user is configured).
                    </p>
                    <form.Field name="tenantId">
                      {(field) => (
                        <TextField
                          error={fieldErrorMessage(field.state.meta.errors)}
                          limits={`Up to ${SCOPE_LIMITS.tenantId} characters, ${SCOPE_ID_RULE}.`}
                          purpose="Required. Events without a tenant are never visible to this key."
                          id={`${ids}-tenant`}
                          label="Tenant id"
                          onChange={field.handleChange}
                          placeholder="biz_5"
                          value={field.state.value}
                        />
                      )}
                    </form.Field>
                    {/* One target, some actions, hidden fields: optional, so closed until wanted (it opens itself when any of them
                        has a value or an error). The summary below always shows the whole scope. */}
                    <form.Subscribe
                      selector={(st) => ({
                        set: Boolean(st.values.targetType || st.values.targetId || st.values.actionPrefixes.trim() || st.values.masks.length),
                        invalid: Boolean(
                          st.fieldMeta.targetType?.errors.length ||
                            st.fieldMeta.targetId?.errors.length ||
                            st.fieldMeta.actionPrefixes?.errors.length,
                        ),
                      })}
                    >
                      {({ set, invalid }) => (
                        <details
                          className="group flex min-w-0 flex-col gap-3 [&[open]>summary]:mb-3"
                          data-testid="narrow-further"
                          onToggle={(e) => setNarrowOpen((e.target as HTMLDetailsElement).open)}
                          open={narrowOpen || set || invalid}
                        >
                          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                            <ChevronDownIcon className="-rotate-90 size-4 text-muted-foreground transition-transform group-open:rotate-0" />
                            Narrow further <span className="font-normal text-muted-foreground">· one target, some actions, hidden fields</span>
                          </summary>
                          <div className="flex min-w-0 flex-col gap-3">
                            <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                              <form.Field name="targetType">
                                {(field) => (
                                  <TextField
                                    error={fieldErrorMessage(field.state.meta.errors)}
                                    limits={`Up to ${SCOPE_LIMITS.targetType} characters, ${SCOPE_ID_RULE}.`}
                                    id={`${ids}-target-type`}
                                    label="Target type"
                                    onChange={field.handleChange}
                                    optional
                                    placeholder="website"
                                    value={field.state.value}
                                  />
                                )}
                              </form.Field>
                              <form.Field name="targetId">
                                {(field) => (
                                  <TextField
                                    error={fieldErrorMessage(field.state.meta.errors)}
                                    limits={`Up to ${SCOPE_LIMITS.targetId} characters, ${SCOPE_ID_RULE}.`}
                                    purpose="Only events with a target of this type and id."
                                    id={`${ids}-target-id`}
                                    label="Target id"
                                    onChange={field.handleChange}
                                    optional
                                    placeholder="site_42"
                                    value={field.state.value}
                                  />
                                )}
                              </form.Field>
                            </div>
                            <form.Field name="actionPrefixes">
                              {(field) => (
                                <TextField
                                  error={fieldErrorMessage(field.state.meta.errors)}
                                  limits={`One per line, up to ${SCOPE_LIMITS.actionPrefixes}, each up to ${SCOPE_LIMITS.actionPrefix} characters, ${SCOPE_ID_RULE}.`}
                                  purpose="Only actions that start with one of these."
                                  id={`${ids}-actions`}
                                  label="Action prefixes"
                                  multiline
                                  onChange={field.handleChange}
                                  optional
                                  placeholder={'booking.\nauth.'}
                                  value={field.state.value}
                                />
                              )}
                            </form.Field>
                            <form.Field name="masks">
                              {(field) => (
                                <fieldset className="flex min-w-0 flex-col gap-1.5">
                                  <legend className="font-medium text-sm">
                                    Hide <span className="font-normal text-muted-foreground">· optional</span>
                                  </legend>
                                  {SCOPE_MASKS.map((mask) => (
                                    // biome-ignore lint/a11y/noLabelWithoutControl: the Base UI checkbox inside is the control.
                                    <label className="flex items-start gap-2 text-sm" key={mask}>
                                      <Checkbox
                                        checked={field.state.value.includes(mask)}
                                        className="mt-0.5"
                                        onCheckedChange={(checked) =>
                                          field.handleChange(checked ? [...field.state.value, mask] : field.state.value.filter((m) => m !== mask))
                                        }
                                      />
                                      <span>
                                        {MASK_LABEL[mask]} <span className="text-muted-foreground text-xs">· {MASK_HINT[mask]}</span>
                                      </span>
                                    </label>
                                  ))}
                                  <p className="text-muted-foreground text-xs">Hiding any field also hides each event’s raw payload.</p>
                                </fieldset>
                              )}
                            </form.Field>
                          </div>
                        </details>
                      )}
                    </form.Subscribe>
                  </fieldset>
                ) : null
              }
            </form.Subscribe>
            <form.Subscribe selector={(s) => s.values.kind}>
              {(kind) =>
                kind === 'ingest' ? null : (
                  <form.Field name="embedOrigins">
                    {(field) => (
                      <TextField
                        error={fieldErrorMessage(field.state.meta.errors)}
                        limits={`One per line, up to ${SCOPE_LIMITS.embedOrigins}: ${ORIGIN_RULE}`}
                        purpose="Where its viewer tokens may be used. Leave empty for servers only."
                        id={`${ids}-origins`}
                        label="Browser origins"
                        multiline
                        onChange={field.handleChange}
                        optional
                        placeholder="https://app.example.com"
                        value={field.state.value}
                      />
                    )}
                  </form.Field>
                )
              }
            </form.Subscribe>
            <form.Field name="expiry">
              {(field) => (
                <ExpiryChoice
                  label="Expires"
                  note={expiryNote(expiryFor(field.state.value))}
                  onChange={field.handleChange}
                  options={KEY_EXPIRY_PRESETS.map((p) => ({ id: p.id, label: p.days ? `In ${p.label}` : p.label }))}
                  value={field.state.value}
                />
              )}
            </form.Field>
            <form.Subscribe selector={(s) => s.values}>
              {(values) => (
                <KeyGrantSummary
                  embedOrigins={values.kind === 'ingest' ? [] : values.embedOrigins.split(/\r?\n/).filter((l) => l.trim() !== '')}
                  expiresAt={expiryFor(values.expiry) ?? null}
                  kind={values.kind}
                  scope={values.kind === 'scoped-read' ? formScope(values) : null}
                />
              )}
            </form.Subscribe>
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
