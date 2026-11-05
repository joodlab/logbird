import { useForm } from '@tanstack/react-form';
import { INVITE_LINK_EXPIRY_DAYS, type InviteLink } from '@trailmark/contracts';
import { CopyButton } from '@trailmark/ui/components/copy-button';
import { ErrorState } from '@trailmark/ui/components/states';
import { Button } from '@trailmark/ui/components/ui/button';
import { useConfirm } from '@trailmark/ui/components/ui/confirm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@trailmark/ui/components/ui/dialog';
import { Input } from '@trailmark/ui/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@trailmark/ui/components/ui/input-group';
import { Label } from '@trailmark/ui/components/ui/label';
import { SegmentedControl, SegmentedControlItem } from '@trailmark/ui/components/ui/segmented-control';
import { Skeleton } from '@trailmark/ui/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@trailmark/ui/components/ui/tooltip';
import { cn } from '@trailmark/ui/lib/utils';
import { CheckCircle2Icon, ChevronDownIcon, Link2Icon, Loader2Icon, LockIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useId, useState } from 'react';
import { Timestamp } from '@/components/timestamp';
import { errorMessage } from '@/lib/api/errors';
import { creatorLabel } from '@/lib/events';
import { formatFull } from '@/lib/format';
import { fieldErrorMessage } from '@/lib/forms';
import {
  DOMAIN_RE,
  emailDomain,
  INVITE_LINK_STATE_LABEL,
  type InviteLinkRole,
  normalizeDomain,
  useCreateInviteLink,
  useInviteLinks,
  useRevokeInviteLink,
  usesLabel,
} from '@/lib/invite-links';
import { ROLE_INFO, roleLabel, useOrganization } from '@/lib/organization';

/** Webmail domains are never offered as a one-click "only people from my company" restriction. */
const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'proton.me']);

/**
 * Shareable join links for the active workspace (Settings → Members, next to the email form). Owners and admins create,
 * copy and revoke them; everyone else gets a read-only note because the list itself is admin-only.
 */
export function InviteLinkPanel() {
  const { org, canManage } = useOrganization();
  const links = useInviteLinks();
  const [createOpen, setCreateOpen] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const active = links.data?.filter((l) => l.state === 'active') ?? [];
  const inactive = links.data?.filter((l) => l.state !== 'active') ?? [];

  return (
    <div className="flex flex-col gap-3" data-testid="invite-link-panel">
      <div className="flex items-start justify-between gap-3">
        <PanelHeading
          description="Anyone with the link can join until it expires, runs out of uses or is revoked."
          icon={Link2Icon}
          title="Invite link"
        />
        {canManage && active.length > 0 ? (
          <Button onClick={() => setCreateOpen(true)} size="sm" variant="outline">
            <PlusIcon />
            New link
          </Button>
        ) : null}
      </div>

      {!(canManage || org.isPending) ? (
        <p
          className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2.5 text-muted-foreground text-sm"
          data-testid="invite-link-readonly"
        >
          <LockIcon className="mt-0.5 size-4 shrink-0" />
          Only owners and admins can create invite links. Ask one of them for a link to share.
        </p>
      ) : links.isPending ? (
        <Skeleton className="h-[74px] w-full rounded-lg" />
      ) : links.isError ? (
        <ErrorState error={links.error} onRetry={() => links.refetch()} size="sm" title="Could not load invite links" />
      ) : active.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-4" data-testid="invite-link-empty">
          <div className="flex flex-col gap-0.5">
            <p className="font-medium text-sm">No active invite links</p>
            <p className="text-muted-foreground text-sm">Share one link in Slack, a doc or an email thread instead of inviting people one by one.</p>
          </div>
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <Link2Icon />
            Create invite link
          </Button>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="invite-links">
          {active.map((link) => (
            <InviteLinkRow key={link.id} link={link} />
          ))}
        </ul>
      )}

      {canManage && inactive.length > 0 ? (
        <div className="flex flex-col gap-2">
          <button
            aria-expanded={showInactive}
            className="inline-flex items-center gap-1 self-start text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:underline"
            onClick={() => setShowInactive((v) => !v)}
            type="button"
          >
            <ChevronDownIcon className={cn('size-3.5 transition-transform', showInactive && 'rotate-180')} />
            {showInactive ? 'Hide' : 'Show'} {inactive.length} inactive {inactive.length === 1 ? 'link' : 'links'}
          </button>
          {showInactive ? (
            <ul className="divide-y rounded-lg border bg-muted/20" data-testid="invite-links-inactive">
              {inactive.map((link) => (
                <InviteLinkRow key={link.id} link={link} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <CreateInviteLinkDialog onOpenChange={setCreateOpen} open={createOpen} />
    </div>
  );
}

export function PanelHeading({ icon: Icon, title, description }: { icon: typeof Link2Icon; title: string; description: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-md border bg-muted/50 text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="font-medium text-sm">{title}</h3>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
    </div>
  );
}

function InviteLinkRow({ link }: { link: InviteLink }) {
  const confirm = useConfirm();
  const revoke = useRevokeInviteLink();
  const isActive = link.state === 'active';
  const display = link.url.replace(/^https?:\/\//, '');
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5" data-state={link.state} data-testid="invite-link-row">
      <div className="flex min-w-0 items-center gap-2">
        <code
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-[12.5px]',
            !isActive && 'text-muted-foreground line-through decoration-muted-foreground/40',
          )}
          title={link.url}
        >
          {display}
        </code>
        {isActive ? (
          <>
            <CopyButton label="Copy link" showLabel size="sm" value={link.url} variant="outline" />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Revoke invite link"
                    className="text-muted-foreground hover:text-destructive"
                    disabled={revoke.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: 'Revoke this invite link?',
                        description:
                          `It stops working immediately for anyone who has not joined yet. ${link.uses ? `The ${link.uses} ${link.uses === 1 ? 'person' : 'people'} who already joined stay${link.uses === 1 ? 's' : ''} in the workspace.` : ''}`.trim(),
                        confirmLabel: 'Revoke link',
                        destructive: true,
                      });
                      if (ok) revoke.mutate(link);
                    }}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                {revoke.isPending && revoke.variables?.id === link.id ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
              </TooltipTrigger>
              <TooltipContent>Revoke</TooltipContent>
            </Tooltip>
          </>
        ) : (
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{INVITE_LINK_STATE_LABEL[link.state]}</span>
        )}
      </div>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground text-xs">
        <span className="font-medium text-foreground">{roleLabel(link.role)}</span>
        <Dot />
        <span className="tabular-nums">{usesLabel(link)}</span>
        <Dot />
        {link.state === 'revoked' && link.revokedAt ? (
          <span>
            revoked <Timestamp format="relative" iso={link.revokedAt} />
          </span>
        ) : (
          <span title={formatFull(link.expiresAt)}>
            {link.state === 'expired' ? 'expired' : 'expires'} <Timestamp format="relative" iso={link.expiresAt} />
          </span>
        )}
        {link.allowedDomain ? (
          <>
            <Dot />
            <span>
              only <span className="font-mono text-foreground">@{link.allowedDomain}</span>
            </span>
          </>
        ) : null}
        {creatorLabel(link.createdBy) ? (
          <>
            <Dot />
            <span className="truncate" dir="auto">
              by {creatorLabel(link.createdBy)}
            </span>
          </>
        ) : null}
      </p>
    </li>
  );
}

const Dot = () => <span aria-hidden="true">·</span>;

const EXPIRY_LABEL: Record<number, string> = { 1: '1 day', 7: '7 days', 30: '30 days' };

function CreateInviteLinkDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const id = useId();
  const { me } = useOrganization();
  const create = useCreateInviteLink();
  const [created, setCreated] = useState<InviteLink | null>(null);
  const myDomain = emailDomain(me.data?.user.email ?? '');
  const suggestDomain = myDomain && !PUBLIC_DOMAINS.has(myDomain) ? myDomain : null;

  const form = useForm({
    defaultValues: { role: 'member' as InviteLinkRole, expiresInDays: 7, maxUses: '', allowedDomain: '' },
    onSubmit: async ({ value }) => {
      const domain = normalizeDomain(value.allowedDomain);
      try {
        const link = await create.mutateAsync({
          role: value.role,
          expiresInDays: value.expiresInDays,
          maxUses: value.maxUses.trim() ? Number(value.maxUses) : null,
          allowedDomain: domain || null,
        });
        setCreated(link);
      } catch {
        // Shown inline.
      }
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
      <DialogContent className="sm:max-w-md" data-testid="create-invite-link-dialog">
        {created ? (
          <div className="flex min-w-0 flex-col gap-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2Icon className="size-5 text-outcome-success" />
                Invite link ready
              </DialogTitle>
              <DialogDescription>
                Share it with the people you want in this workspace. You can copy it again or revoke it from Members.
              </DialogDescription>
            </DialogHeader>
            <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/40 py-1.5 ps-3 pe-1.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[13px]" data-testid="created-invite-link">
                {created.url}
              </code>
              <CopyButton label="Copy link" showLabel size="sm" value={created.url} variant="outline" />
            </div>
            <p className="text-muted-foreground text-xs">
              Joins as <span className="font-medium text-foreground">{roleLabel(created.role).toLowerCase()}</span>
              {created.allowedDomain ? (
                <>
                  {' '}
                  · only <span className="font-mono text-foreground">@{created.allowedDomain}</span> emails
                </>
              ) : null}{' '}
              · {created.maxUses ? `up to ${created.maxUses} ${created.maxUses === 1 ? 'person' : 'people'}` : 'no use limit'} · expires{' '}
              {formatFull(created.expiresAt)}
            </p>
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="flex min-w-0 flex-col gap-5"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              form.handleSubmit();
            }}
          >
            <DialogHeader>
              <DialogTitle>Create invite link</DialogTitle>
              <DialogDescription>Anyone who opens it can join this workspace with the role you choose.</DialogDescription>
            </DialogHeader>

            <form.Field name="role">
              {(field) => (
                <div className="flex flex-col gap-1.5">
                  <Label id={`${id}-role`}>Role</Label>
                  <SegmentedControl aria-labelledby={`${id}-role`} className="flex-nowrap" role="group">
                    {(['member', 'admin'] as const).map((role) => (
                      <SegmentedControlItem active={field.state.value === role} key={role} onClick={() => field.handleChange(role)}>
                        {ROLE_INFO[role].label}
                      </SegmentedControlItem>
                    ))}
                  </SegmentedControl>
                  <p className="text-muted-foreground text-xs">{ROLE_INFO[field.state.value].description}</p>
                </div>
              )}
            </form.Field>

            <form.Field name="expiresInDays">
              {(field) => (
                <div className="flex flex-col gap-1.5">
                  <Label id={`${id}-expiry`}>Expires after</Label>
                  <SegmentedControl aria-labelledby={`${id}-expiry`} className="flex-nowrap" role="group">
                    {INVITE_LINK_EXPIRY_DAYS.map((days) => (
                      <SegmentedControlItem active={field.state.value === days} key={days} onClick={() => field.handleChange(days)}>
                        {EXPIRY_LABEL[days]}
                      </SegmentedControlItem>
                    ))}
                  </SegmentedControl>
                </div>
              )}
            </form.Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <form.Field
                name="maxUses"
                validators={{
                  onSubmit: ({ value }) => {
                    if (!value.trim()) return;
                    const n = Number(value);
                    if (!Number.isInteger(n) || n < 1 || n > 1000) return 'Use a whole number from 1 to 1000.';
                  },
                }}
              >
                {(field) => {
                  const message = fieldErrorMessage(field.state.meta.errors);
                  return (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${id}-uses`}>
                        Max uses <span className="font-normal text-muted-foreground">· optional</span>
                      </Label>
                      <Input
                        aria-invalid={Boolean(message) || undefined}
                        id={`${id}-uses`}
                        inputMode="numeric"
                        max={1000}
                        min={1}
                        onChange={(e) => field.handleChange(e.target.value)}
                        placeholder="Unlimited"
                        type="number"
                        value={field.state.value}
                      />
                      {message ? <p className="text-destructive text-xs">{message}</p> : null}
                    </div>
                  );
                }}
              </form.Field>

              <form.Field
                name="allowedDomain"
                validators={{
                  onSubmit: ({ value }) => {
                    const domain = normalizeDomain(value);
                    if (domain && !DOMAIN_RE.test(domain)) return 'Enter a domain like acme.com.';
                  },
                }}
              >
                {(field) => {
                  const message = fieldErrorMessage(field.state.meta.errors);
                  return (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${id}-domain`}>
                        Email domain <span className="font-normal text-muted-foreground">· optional</span>
                      </Label>
                      <InputGroup>
                        <InputGroupAddon>@</InputGroupAddon>
                        <InputGroupInput
                          aria-invalid={Boolean(message) || undefined}
                          autoCapitalize="none"
                          autoComplete="off"
                          id={`${id}-domain`}
                          onChange={(e) => field.handleChange(e.target.value)}
                          placeholder={suggestDomain ?? 'acme.com'}
                          spellCheck={false}
                          value={field.state.value}
                        />
                      </InputGroup>
                      {message ? (
                        <p className="text-destructive text-xs">{message}</p>
                      ) : suggestDomain && !field.state.value ? (
                        <button
                          className="self-start text-brand text-xs hover:underline"
                          onClick={() => field.handleChange(suggestDomain)}
                          type="button"
                        >
                          Only @{suggestDomain}
                        </button>
                      ) : (
                        <p className="text-muted-foreground text-xs">{field.state.value ? 'Other addresses cannot join.' : 'Any email can join.'}</p>
                      )}
                    </div>
                  );
                }}
              </form.Field>
            </div>

            {create.isError ? (
              <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-sm" role="alert">
                {errorMessage(create.error)}
              </p>
            ) : null}
            <DialogFooter>
              <Button onClick={() => close(false)} type="button" variant="outline">
                Cancel
              </Button>
              <form.Subscribe selector={(s) => s.isSubmitting}>
                {(submitting) => (
                  <Button data-testid="create-invite-link-submit" disabled={submitting} type="submit">
                    {submitting ? <Loader2Icon className="animate-spin" /> : <Link2Icon />}
                    Create link
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
