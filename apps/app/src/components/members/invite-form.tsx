import { Button } from '@logbird/ui/components/ui/button';
import { Input } from '@logbird/ui/components/ui/input';
import { Label } from '@logbird/ui/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@logbird/ui/components/ui/native-select';
import { useForm } from '@tanstack/react-form';
import { Loader2Icon, MailIcon, UserPlusIcon } from 'lucide-react';
import { useId } from 'react';
import { z } from 'zod';
import { fieldErrorMessage } from '@/lib/forms';
import { INVITE_ROLES, ROLE_INFO, type Role, useInviteMember, useOrganization } from '@/lib/organization';

const emailSchema = z.email('Enter a valid email address.');

/**
 * Email + role invite form, shared by Settings → Members (half-width column) and the Setup page's teammate step
 * (full width). A container query puts it on one row only when there is room for it.
 */
export function InviteForm({ compact = false }: { compact?: boolean }) {
  const id = useId();
  const { org, canManage, pending } = useOrganization();
  const invite = useInviteMember();
  const memberEmails = new Set(org.data?.members.map((m) => m.user.email.toLowerCase()));
  const pendingEmails = new Set(pending.map((i) => i.email.toLowerCase()));

  const form = useForm({
    defaultValues: { email: '', role: 'member' as Role },
    onSubmit: async ({ value, formApi }) => {
      const email = value.email.trim().toLowerCase();
      try {
        await invite.mutateAsync({ email, role: value.role, resend: pendingEmails.has(email) });
        formApi.reset();
      } catch {
        // Shown inline below.
      }
    },
  });

  return (
    <div className="@container flex flex-col gap-2">
      <form
        className="flex flex-col gap-2 @lg:flex-row @lg:items-start"
        data-testid="invite-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          form.handleSubmit();
        }}
      >
        <form.Field
          name="email"
          validators={{
            onSubmit: ({ value }) => {
              const parsed = emailSchema.safeParse(value.trim());
              if (!parsed.success) return parsed.error.issues[0]?.message;
              if (memberEmails.has(value.trim().toLowerCase())) return 'Already a member of this workspace.';
            },
          }}
        >
          {(field) => {
            const message = fieldErrorMessage(field.state.meta.errors);
            const alreadyInvited = pendingEmails.has(field.state.value.trim().toLowerCase());
            return (
              <div className="flex flex-1 flex-col gap-1">
                <Label className="sr-only" htmlFor={`${id}-email`}>
                  Email
                </Label>
                <div className="relative">
                  <MailIcon className="-translate-y-1/2 pointer-events-none absolute start-3 top-1/2 size-4 text-muted-foreground" />
                  <Input
                    aria-invalid={Boolean(message) || undefined}
                    autoComplete="off"
                    className="ps-9"
                    disabled={!canManage}
                    id={`${id}-email`}
                    onChange={(e) => {
                      field.handleChange(e.target.value);
                      invite.reset();
                    }}
                    placeholder="teammate@company.com"
                    type="email"
                    value={field.state.value}
                  />
                </div>
                {message ? (
                  <p className="text-destructive text-xs">{message}</p>
                ) : alreadyInvited ? (
                  <p className="text-muted-foreground text-xs">Already invited — sending again re-sends the email and extends the link.</p>
                ) : null}
              </div>
            );
          }}
        </form.Field>
        <div className="flex gap-2">
          <form.Field name="role">
            {(field) => (
              <NativeSelect
                aria-label="Role"
                className="flex-1 @lg:w-32 @lg:flex-none"
                disabled={!canManage}
                onChange={(e) => field.handleChange(e.target.value as Role)}
                title={ROLE_INFO[field.state.value].description}
                value={field.state.value}
              >
                {INVITE_ROLES.map((role) => (
                  <NativeSelectOption key={role} value={role}>
                    {ROLE_INFO[role].label}
                  </NativeSelectOption>
                ))}
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
        </div>
      </form>
      {invite.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {invite.error.message}
        </p>
      ) : null}
      {!canManage && org.data ? <p className="text-muted-foreground text-xs">Only owners and admins can invite people.</p> : null}
      {compact ? null : (
        <form.Subscribe selector={(s) => s.values.role}>
          {(role) => (
            <p className="text-muted-foreground text-xs">
              {ROLE_INFO[role].label}s: {ROLE_INFO[role].description.toLowerCase()}
            </p>
          )}
        </form.Subscribe>
      )}
    </div>
  );
}
