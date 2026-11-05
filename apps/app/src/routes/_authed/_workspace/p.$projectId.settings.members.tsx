import { createFileRoute } from '@tanstack/react-router';
import { TypePill } from '@trailmark/ui/components/badges';
import { CopyButton } from '@trailmark/ui/components/copy-button';
import { EmptyState, ErrorState } from '@trailmark/ui/components/states';
import { Button } from '@trailmark/ui/components/ui/button';
import { useConfirm } from '@trailmark/ui/components/ui/confirm';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@trailmark/ui/components/ui/dropdown-menu';
import { NativeSelect, NativeSelectOption } from '@trailmark/ui/components/ui/native-select';
import { Skeleton } from '@trailmark/ui/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@trailmark/ui/components/ui/tooltip';
import { Loader2Icon, MailIcon, MoreHorizontalIcon, RotateCwIcon, ShieldIcon, UserMinusIcon, XIcon } from 'lucide-react';
import { UserAvatar } from '@/components/account/user-avatar';
import { InviteForm } from '@/components/members/invite-form';
import { InviteLinkPanel, PanelHeading } from '@/components/members/invite-link-panel';
import { SettingsSection } from '@/components/settings-section';
import { Timestamp } from '@/components/timestamp';
import {
  invitationUrl,
  type OrgMember,
  ROLE_INFO,
  type Role,
  roleLabel,
  useInviteMember,
  useMemberActions,
  useOrganization,
} from '@/lib/organization';
import { placeholderKeys } from '@/lib/placeholders';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/members')({
  staticData: { crumb: 'Members' },
  head: () => ({ meta: [{ title: 'Members · Trailmark' }] }),
  component: MembersSettings,
});

function MembersSettings() {
  const { me, org, myRole, owners, canManage, pending } = useOrganization();
  const confirm = useConfirm();
  const { cancel, remove, changeRole } = useMemberActions();
  const resend = useInviteMember();
  const members = [...(org.data?.members ?? [])].sort((a, b) => rank(a.role) - rank(b.role) || a.user.email.localeCompare(b.user.email));

  /** What I may do to this member. Mirrors better-auth's rules so we never offer an action it rejects. */
  const permissions = (m: OrgMember) => {
    const self = m.userId === me.data?.user.id;
    const lastOwner = m.role === 'owner' && owners <= 1;
    const touchable = canManage && !self && (m.role !== 'owner' || myRole === 'owner');
    return { self, lastOwner, canChangeRole: touchable && !lastOwner, canRemove: touchable && !lastOwner };
  };

  const confirmRole = async (m: OrgMember, role: Role) => {
    if (role === m.role) return;
    const name = m.user.name || m.user.email;
    const ok = await confirm({
      title: `Make ${name} ${role === 'admin' || role === 'owner' ? 'an' : 'a'} ${roleLabel(role).toLowerCase()}?`,
      description:
        role === 'owner'
          ? 'Owners can do everything, including removing other owners and deleting the workspace. You cannot undo this alone if they demote you.'
          : `${ROLE_INFO[role].label}s: ${ROLE_INFO[role].description.toLowerCase()}`,
      confirmLabel: `Make ${roleLabel(role).toLowerCase()}`,
      destructive: role === 'owner',
    });
    if (ok) changeRole.mutate({ member: m, role });
  };

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection
        description={
          <>
            Everyone in <span className="font-medium text-foreground">{org.data?.name ?? 'this workspace'}</span> can see every project. Invite
            someone by email, or share a link with a group.
          </>
        }
        title="Invite people"
      >
        <div className="grid gap-6 lg:grid-cols-2 lg:gap-0 lg:divide-x">
          <div className="flex flex-col gap-3 lg:pe-6" data-testid="invite-by-email">
            <PanelHeading
              description="A personal link for one address, valid for 48 hours. Copy it from Pending invitations."
              icon={MailIcon}
              title="Email invitation"
            />
            <InviteForm />
          </div>
          <div className="max-lg:border-t max-lg:pt-6 lg:ps-6">
            <InviteLinkPanel />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={`Members${org.data ? ` · ${org.data.members.length}` : ''}`}>
        {org.isPending ? (
          <div className="flex flex-col gap-2">
            {placeholderKeys(3).map((k) => (
              <Skeleton className="h-14 w-full" key={k} />
            ))}
          </div>
        ) : org.isError ? (
          <ErrorState error={org.error} onRetry={() => org.refetch()} size="sm" />
        ) : (
          <ul className="divide-y rounded-lg border" data-testid="members-list">
            {members.map((m) => {
              const p = permissions(m);
              const name = m.user.name || m.user.email;
              return (
                <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3" key={m.id}>
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <UserAvatar size="md" user={{ id: m.userId, name: m.user.name, email: m.user.email }} />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium text-sm" dir="auto">
                        {name} {p.self ? <span className="font-normal text-muted-foreground">(you)</span> : null}
                      </span>
                      <span className="truncate text-muted-foreground text-xs">
                        {m.user.email} · joined <Timestamp format="date" iso={new Date(m.createdAt).toISOString()} />
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ps-11 sm:ps-0">
                    {p.canChangeRole ? (
                      <NativeSelect
                        aria-label={`Role of ${name}`}
                        className="w-28"
                        disabled={changeRole.isPending}
                        onChange={(e) => confirmRole(m, e.target.value as Role)}
                        size="sm"
                        value={m.role}
                      >
                        {(myRole === 'owner' ? (['member', 'admin', 'owner'] as Role[]) : (['member', 'admin'] as Role[])).map((r) => (
                          <NativeSelectOption key={r} value={r}>
                            {ROLE_INFO[r].label}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger render={<span />}>
                          <TypePill tone={m.role === 'owner' ? 'brand' : 'neutral'}>
                            {m.role === 'owner' ? <ShieldIcon className="me-1 size-3" /> : null}
                            {roleLabel(m.role).toLowerCase()}
                          </TypePill>
                        </TooltipTrigger>
                        <TooltipContent>
                          {p.lastOwner
                            ? 'The only owner. Make someone else an owner before changing this role.'
                            : p.self
                              ? 'Ask another owner or admin to change your role.'
                              : (ROLE_INFO[m.role as Role]?.description ?? '')}
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {p.canRemove ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button aria-label={`Actions for ${name}`} size="icon-sm" variant="ghost" />}>
                          <MoreHorizontalIcon />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuItem
                            onClick={async () => {
                              const ok = await confirm({
                                title: `Remove ${name}?`,
                                description:
                                  'They lose access to every project in this workspace immediately. Their past actions stay in the audit trail.',
                                confirmLabel: 'Remove member',
                                destructive: true,
                              });
                              if (ok) remove.mutate(m);
                            }}
                            variant="destructive"
                          >
                            <UserMinusIcon />
                            Remove from workspace
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <span className="hidden size-(--control-size-compact) sm:block" />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsSection>

      <SettingsSection
        description="People who were invited but have not accepted yet. Re-sending extends the link by 48 hours."
        title={`Pending invitations${org.data ? ` · ${pending.length}` : ''}`}
      >
        {org.isPending ? (
          <Skeleton className="h-14 w-full" />
        ) : pending.length === 0 ? (
          <EmptyState
            description="Invite someone above — they show up here until they accept."
            icon={MailIcon}
            size="sm"
            title="No pending invitations"
          />
        ) : (
          <ul className="divide-y rounded-lg border" data-testid="pending-invitations">
            {pending.map((i) => (
              <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3" key={i.id}>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed text-muted-foreground">
                    <MailIcon className="size-3.5" />
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{i.email}</span>
                    <span className="text-muted-foreground text-xs">
                      {roleLabel(i.role ?? 'member').toLowerCase()} · expires{' '}
                      <Timestamp format="relative" iso={new Date(i.expiresAt).toISOString()} />
                    </span>
                  </div>
                </div>
                {canManage ? (
                  <div className="flex items-center gap-1 ps-11 sm:ps-0">
                    <CopyButton label="Copy link" showLabel size="sm" value={invitationUrl(i.id)} variant="outline" />
                    <Button
                      disabled={resend.isPending}
                      onClick={() => resend.mutate({ email: i.email, role: (i.role ?? 'member') as Role, resend: true })}
                      size="sm"
                      variant="ghost"
                    >
                      {resend.isPending && resend.variables?.email === i.email ? <Loader2Icon className="animate-spin" /> : <RotateCwIcon />}
                      Resend
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button aria-label={`Actions for ${i.email}`} size="icon-sm" variant="ghost" />}>
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Cancel the invitation for ${i.email}?`,
                              description: 'The link in their email stops working. You can invite them again later.',
                              confirmLabel: 'Cancel invitation',
                              destructive: true,
                            });
                            if (ok) cancel.mutate(i.id);
                          }}
                          variant="destructive"
                        >
                          <XIcon />
                          Cancel invitation
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <SettingsSection title="Roles">
        <ul className="grid gap-2 sm:grid-cols-3">
          {(['owner', 'admin', 'member'] as Role[]).map((r) => (
            <li className="flex flex-col gap-0.5 rounded-lg border p-3" key={r}>
              <span className="font-medium text-sm">{ROLE_INFO[r].label}</span>
              <span className="text-muted-foreground text-xs">{ROLE_INFO[r].description}</span>
            </li>
          ))}
        </ul>
      </SettingsSection>
    </div>
  );
}

const rank = (role: string) => ({ owner: 0, admin: 1, member: 2 })[role] ?? 3;
