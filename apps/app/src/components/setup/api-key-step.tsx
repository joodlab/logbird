import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ApiKey } from '@trailmark/contracts';
import { TypePill } from '@trailmark/ui/components/badges';
import { CopyButton } from '@trailmark/ui/components/copy-button';
import { ErrorState } from '@trailmark/ui/components/states';
import { Button } from '@trailmark/ui/components/ui/button';
import { Input } from '@trailmark/ui/components/ui/input';
import { Label } from '@trailmark/ui/components/ui/label';
import { Skeleton } from '@trailmark/ui/components/ui/skeleton';
import { CheckIcon, KeyRoundIcon, Loader2Icon, PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { keysQuery } from '@/lib/api/queries';
import { ingestSecretId, readSecretId, stashSecret, useSecret } from '@/lib/one-time-secrets';
import { useCan } from '@/lib/permissions';
import { AdminNote } from '../admin-gate';
import { Timestamp } from '../timestamp';
import { useInvalidateSetup } from './use-setup';

type Kind = ApiKey['kind'];

const COPY: Record<Kind, { defaultName: string; label: string; prefix: string }> = {
  ingest: { defaultName: 'Production backend', label: 'ingest key', prefix: 'tm_ingest_' },
  read: { defaultName: 'Product read access', label: 'read key', prefix: 'tm_read_' },
};

/** The secret for `kind` known in this browser session (created here, at project creation, or pasted). */
export function useSessionKey(projectId: string, kind: Kind) {
  return useSecret(kind === 'ingest' ? ingestSecretId(projectId) : readSecretId(projectId));
}

/**
 * Inline key step: create a key without leaving the page and reveal the secret exactly once. Afterwards every snippet
 * on the page uses it for this session. Without a session secret it shows the active key prefixes and lets the
 * operator paste their own key to fill the snippets (kept in memory only).
 */
export function ApiKeyStep({ projectId, kind }: { projectId: string; kind: Kind }) {
  const id = useId();
  const secret = useSessionKey(projectId, kind);
  const secretId = kind === 'ingest' ? ingestSecretId(projectId) : readSecretId(projectId);
  const list = useQuery(keysQuery(projectId));
  const invalidate = useInvalidateSetup(projectId);
  const [name, setName] = useState(COPY[kind].defaultName);
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ key: ApiKey; secret: string } | null>(null);
  const [pasted, setPasted] = useState('');
  const manage = useCan()('keys.manage');
  const create = useMutation({
    mutationFn: () => api.keys.create(projectId, { name: name.trim() || COPY[kind].defaultName, kind }),
    onSuccess: (result) => {
      stashSecret(secretId, result.secret);
      setRevealed(result);
      setCreating(false);
      invalidate();
    },
  });

  const active = (list.data ?? []).filter((k) => k.kind === kind && !k.revokedAt);
  const pastedValid = pasted.trim().startsWith(COPY[kind].prefix) && pasted.trim().length > COPY[kind].prefix.length + 8;

  if (list.isPending) return <Skeleton className="h-24 w-full" />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => list.refetch()} size="sm" />;

  const form = (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <div className="flex flex-1 flex-col gap-1.5">
        <Label htmlFor={`${id}-name`}>Key name</Label>
        <Input id={`${id}-name`} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder={COPY[kind].defaultName} value={name} />
      </div>
      <Button disabled={create.isPending} type="submit">
        {create.isPending ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
        Create {COPY[kind].label}
      </Button>
      {active.length > 0 ? (
        <Button onClick={() => setCreating(false)} type="button" variant="ghost">
          Cancel
        </Button>
      ) : null}
    </form>
  );

  return (
    <div className="flex flex-col gap-3">
      {secret ? (
        <div className="tm-fade-in flex flex-col gap-2 rounded-lg border border-outcome-success/30 bg-outcome-success/5 p-3">
          <p className="flex items-center gap-1.5 font-medium text-sm">
            <CheckIcon className="size-4 text-outcome-success" />
            {revealed ? `${revealed.key.name} created` : `Your ${COPY[kind].label} for this session`}
          </p>
          <div className="flex items-center gap-2 rounded-md border bg-background py-1 ps-3 pe-1">
            <code className="min-w-0 flex-1 truncate font-mono text-[13px]" data-testid={`${kind}-secret`}>
              {secret}
            </code>
            <CopyButton label="Copy key" showLabel value={secret} variant="outline" />
          </div>
          <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-outcome-denied" />
            This is the only time the full key is shown. Store it in your secrets manager — Trailmark keeps only a hash. The snippets on this page use
            it until you reload.
          </p>
        </div>
      ) : null}

      {(active.length === 0 || creating) && !manage ? (
        <AdminNote>
          {active.length === 0
            ? `Ask a workspace owner or admin to create ${COPY[kind].label === 'ingest key' ? 'an' : 'a'} ${COPY[kind].label} — only they can create keys.`
            : 'Only workspace owners and admins can create keys.'}{' '}
          Already have one? Paste it below to fill the snippets.
        </AdminNote>
      ) : active.length === 0 || creating ? (
        form
      ) : (
        <ul className="divide-y rounded-lg border">
          {active.slice(0, 4).map((k) => (
            <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" key={k.id}>
              <code className="font-mono text-[12.5px]">{k.prefix}…</code>
              <span className="min-w-0 flex-1 truncate">{k.name}</span>
              <span className="text-muted-foreground text-xs">
                {k.lastUsedAt ? (
                  <>
                    used <Timestamp format="relative" iso={k.lastUsedAt} />
                  </>
                ) : (
                  'never used'
                )}
              </span>
              {secret?.startsWith(k.prefix) ? <TypePill tone="brand">in snippets</TypePill> : null}
            </li>
          ))}
        </ul>
      )}
      {create.isError ? <p className="text-destructive text-sm">{errorMessage(create.error)}</p> : null}

      {(active.length > 0 || !manage) && !creating && !secret ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-paste`}>Paste your key to fill the snippets</Label>
          <div className="flex gap-2">
            <Input
              autoComplete="off"
              className="font-mono text-[13px]"
              id={`${id}-paste`}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={`${active[0]?.prefix ?? COPY[kind].prefix}…  (paste your key)`}
              spellCheck={false}
              value={pasted}
            />
            <Button disabled={!pastedValid} onClick={() => stashSecret(secretId, pasted.trim())} type="button" variant="outline">
              Use key
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            {manage ? (
              <>
                Stays in this tab only. Lost it? Create a new key — old ones can be revoked in{' '}
                <Link className="text-foreground underline underline-offset-2" params={{ projectId }} to="/p/$projectId/settings/keys">
                  Settings → API keys
                </Link>
                .
              </>
            ) : (
              'Stays in this tab only. Lost it? Ask an owner or admin for a new key.'
            )}
          </p>
        </div>
      ) : null}

      {active.length > 0 && !creating && manage ? (
        <Button className="self-start" onClick={() => setCreating(true)} size="sm" variant="ghost">
          <PlusIcon />
          Create another {COPY[kind].label}
        </Button>
      ) : null}
    </div>
  );
}
