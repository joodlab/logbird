import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { TypePill } from '@trailmark/ui/components/badges';
import { EntityAvatar } from '@trailmark/ui/components/entity-chip';
import { ErrorState } from '@trailmark/ui/components/states';
import { Button } from '@trailmark/ui/components/ui/button';
import { useConfirm } from '@trailmark/ui/components/ui/confirm';
import { Input } from '@trailmark/ui/components/ui/input';
import { Label } from '@trailmark/ui/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@trailmark/ui/components/ui/native-select';
import { Skeleton } from '@trailmark/ui/components/ui/skeleton';
import { Loader2Icon, MailIcon, UserPlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { SettingsSection } from '@/components/settings-section';
import { meQuery } from '@/lib/api/queries';
import { authCall, authClient } from '@/lib/auth-client';
import { formatDate, formatRelative } from '@/lib/format';
import { fieldErrorMessage } from '@/lib/forms';
import { placeholderKeys } from '@/lib/placeholders';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/members')({
  staticData: { crumb: 'Members' },
  component: MembersSettings,
});

interface FullOrg {
  id: string;
  name: string;
  members: {
    id: string;
    userId: string;
    role: string;
    createdAt: string | Date;
    user: { id: string; name: string; email: string; image?: string | null };
  }[];
  invitations: { id: string; email: string; role: string | null; status: string; expiresAt: string | Date }[];
}

const ORG_KEY = ['organization', 'full'] as const;
const emailSchema = z.email('Enter a valid email address.');

function MembersSettings() {
  const me = useQuery(meQuery());
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const org = useQuery({
    queryKey: [...ORG_KEY, me.data?.activeOrganizationId],
    queryFn: async () => (await authCall(authClient.organization.getFullOrganization())) as unknown as FullOrg,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ORG_KEY });
  const myRole = org.data?.members.find((m) => m.userId === me.data?.user.id)?.role;
  const canManage = myRole === 'owner' || myRole === 'admin';

  const invite = useMutation({
    mutationFn: (value: { email: string; role: 'member' | 'admin' }) =>
      authCall(authClient.organization.inviteMember({ email: value.email.trim().toLowerCase(), role: value.role })),
    onSuccess: (_, value) => {
      refresh();
      toast.success('Invitation sent', { description: `${value.email} will get an email with a link to join.` });
    },
  });
  const cancel = useMutation({
    mutationFn: (invitationId: string) => authCall(authClient.organization.cancelInvitation({ invitationId })),
    onSuccess: refresh,
    onError: (e) => toast.error('Could not cancel the invitation', { description: e.message }),
  });
  const remove = useMutation({
    mutationFn: (memberIdOrEmail: string) => authCall(authClient.organization.removeMember({ memberIdOrEmail })),
    onSuccess: refresh,
    onError: (e) => toast.error('Could not remove the member', { description: e.message }),
  });
  const changeRole = useMutation({
    mutationFn: (v: { memberId: string; role: 'member' | 'admin' | 'owner' }) =>
      authCall(authClient.organization.updateMemberRole({ memberId: v.memberId, role: v.role })),
    onSuccess: () => {
      refresh();
      toast.success('Role updated');
    },
    onError: (e) => toast.error('Could not change the role', { description: e.message }),
  });

  const form = useForm({
    defaultValues: { email: '', role: 'member' as 'member' | 'admin' },
    onSubmit: async ({ value, formApi }) => {
      try {
        await invite.mutateAsync(value);
        formApi.reset();
      } catch {
        // Shown inline below.
      }
    },
  });

  const pending = org.data?.invitations.filter((i) => i.status === 'pending') ?? [];

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection
        description={
          <>
            Members can see every project in <span className="font-medium text-foreground">{org.data?.name ?? 'this workspace'}</span>. Admins can
            manage keys, retention and members.
          </>
        }
        title="Invite people"
      >
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-start"
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <form.Field name="email" validators={{ onSubmit: emailSchema }}>
            {(field) => {
              const message = fieldErrorMessage(field.state.meta.errors);
              return (
                <div className="flex flex-1 flex-col gap-1">
                  <Label className="sr-only" htmlFor="invite-email">
                    Email
                  </Label>
                  <div className="relative">
                    <MailIcon className="-translate-y-1/2 pointer-events-none absolute start-3 top-1/2 size-4 text-muted-foreground" />
                    <Input
                      aria-invalid={Boolean(message) || undefined}
                      className="ps-9"
                      disabled={!canManage}
                      id="invite-email"
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="teammate@company.com"
                      type="email"
                      value={field.state.value}
                    />
                  </div>
                  {message ? <p className="text-destructive text-xs">{message}</p> : null}
                </div>
              );
            }}
          </form.Field>
          <form.Field name="role">
            {(field) => (
              <NativeSelect
                aria-label="Role"
                className="sm:w-32"
                disabled={!canManage}
                onChange={(e) => field.handleChange(e.target.value as 'member' | 'admin')}
                value={field.state.value}
              >
                <NativeSelectOption value="member">Member</NativeSelectOption>
                <NativeSelectOption value="admin">Admin</NativeSelectOption>
              </NativeSelect>
            )}
          </form.Field>
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(submitting) => (
              <Button disabled={submitting || !canManage} type="submit">
                {submitting ? <Loader2Icon className="animate-spin" /> : <UserPlusIcon />}
                Send invite
              </Button>
            )}
          </form.Subscribe>
        </form>
        {invite.isError ? <p className="text-destructive text-sm">{invite.error.message}</p> : null}
        {!canManage && org.data ? <p className="text-muted-foreground text-xs">Only owners and admins can invite or remove people.</p> : null}
      </SettingsSection>

      <SettingsSection title={`Members${org.data ? ` · ${org.data.members.length}` : ''}`}>
        {org.isPending ? (
          <div className="flex flex-col gap-2">
            {placeholderKeys(3).map((k) => (
              <Skeleton className="h-12 w-full" key={k} />
            ))}
          </div>
        ) : org.isError ? (
          <ErrorState error={org.error} onRetry={() => org.refetch()} size="sm" />
        ) : (
          <ul className="divide-y rounded-lg border">
            {org.data.members.map((m) => {
              const self = m.userId === me.data?.user.id;
              return (
                <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3" key={m.id}>
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <EntityAvatar id={m.userId} name={m.user.name || m.user.email} size="md" />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium text-sm">
                        {m.user.name || m.user.email} {self ? <span className="font-normal text-muted-foreground">(you)</span> : null}
                      </span>
                      <span className="truncate text-muted-foreground text-xs">
                        {m.user.email} · joined {formatDate(new Date(m.createdAt).toISOString())}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {m.role === 'owner' || !canManage || self ? (
                      <TypePill tone={m.role === 'owner' ? 'brand' : 'neutral'}>{m.role}</TypePill>
                    ) : (
                      <NativeSelect
                        aria-label={`Role of ${m.user.name || m.user.email}`}
                        className="h-8 w-28"
                        onChange={(e) => changeRole.mutate({ memberId: m.id, role: e.target.value as 'member' | 'admin' })}
                        value={m.role}
                      >
                        <NativeSelectOption value="member">Member</NativeSelectOption>
                        <NativeSelectOption value="admin">Admin</NativeSelectOption>
                      </NativeSelect>
                    )}
                    {canManage && !self && m.role !== 'owner' ? (
                      <Button
                        className="text-muted-foreground hover:text-destructive"
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Remove ${m.user.name || m.user.email}?`,
                            description: 'They lose access to every project in this workspace. Their past actions stay in the audit trail.',
                            confirmLabel: 'Remove',
                            destructive: true,
                          });
                          if (ok) remove.mutate(m.id);
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsSection>

      {pending.length > 0 ? (
        <SettingsSection description="Invitations expire after 7 days." title={`Pending invitations · ${pending.length}`}>
          <ul className="divide-y rounded-lg border">
            {pending.map((i) => (
              <li className="flex items-center gap-3 px-4 py-3" key={i.id}>
                <span className="flex size-7 items-center justify-center rounded-full border border-dashed text-muted-foreground">
                  <MailIcon className="size-3.5" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{i.email}</span>
                  <span className="text-muted-foreground text-xs">
                    {i.role ?? 'member'} · expires {formatRelative(new Date(i.expiresAt).toISOString())}
                  </span>
                </div>
                {canManage ? (
                  <Button disabled={cancel.isPending} onClick={() => cancel.mutate(i.id)} size="sm" variant="ghost">
                    Cancel
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </SettingsSection>
      ) : null}
    </div>
  );
}
