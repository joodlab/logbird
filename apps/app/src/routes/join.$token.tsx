import type { InviteLinkPreview, MeResponse } from '@logbird/contracts';
import { EntityAvatar } from '@logbird/ui/components/entity-chip';
import { Button } from '@logbird/ui/components/ui/button';
import { Input } from '@logbird/ui/components/ui/input';
import { Label } from '@logbird/ui/components/ui/label';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  ClockIcon,
  Loader2Icon,
  LogOutIcon,
  MailIcon,
  UsersIcon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { DetailRow, LoadingCard, PublicInviteLayout, StateCard } from '@/components/invite/public-invite';
import { Timestamp } from '@/components/timestamp';
import { api } from '@/lib/api/client';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import { inviteLinkPreviewQuery, keys, meQuery } from '@/lib/api/queries';
import { authCall, authClient, sendSignInCode } from '@/lib/auth-client';
import { formatFull } from '@/lib/format';
import { fieldErrorMessage } from '@/lib/forms';
import { emailDomain } from '@/lib/invite-links';
import { ROLE_INFO, roleLabel } from '@/lib/organization';
import { markOtpSent } from '@/lib/otp';

/**
 * Public join page for shareable invite links. The token in the URL is the secret, so the page never gets indexed.
 * Signed out → preview + email sign-in that comes back here; signed in → one click joins and switches to the workspace
 * (`/` then resumes onboarding, e.g. the profile step for brand-new accounts).
 */
export const Route = createFileRoute('/join/$token')({
  head: () => ({ meta: [{ title: 'Join a workspace · Logbird' }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: JoinPage,
});

function JoinPage() {
  const { token } = Route.useParams();
  const preview = useQuery(inviteLinkPreviewQuery(token));
  const session = useQuery({ ...meQuery(), retry: false });
  const signedIn = session.data ?? null;

  let body: ReactNode;
  if (preview.isPending || session.isPending) body = <LoadingCard />;
  else if (preview.isError)
    body =
      preview.error instanceof ApiRequestError && preview.error.status === 404 ? (
        <StateCard
          action={<OpenOrSignIn me={signedIn} />}
          description="Check that the whole link was copied — invite links are long. Otherwise ask the person who shared it for a new one."
          icon={CircleSlashIcon}
          testId="join-unknown"
          title="Invite link not found"
        />
      ) : (
        <StateCard
          action={
            <Button onClick={() => preview.refetch()} variant="outline">
              Try again
            </Button>
          }
          description={errorMessage(preview.error)}
          icon={CircleAlertIcon}
          title="Could not load the invite link"
          tone="danger"
        />
      );
  else body = <JoinLink link={preview.data} me={signedIn} />;

  return <PublicInviteLayout>{body}</PublicInviteLayout>;
}

function JoinLink({ link, me }: { link: InviteLinkPreview; me: MeResponse | null }) {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [domainBlocked, setDomainBlocked] = useState(false);
  const ws = link.organization.name;
  const isMember = Boolean(me?.organizations.some((o) => o.id === link.organization.id));

  const openWorkspace = useMutation({
    mutationFn: (organizationId: string) => authCall(authClient.organization.setActive({ organizationId })),
    onSuccess: async () => {
      queryClient.clear();
      await navigate({ to: '/' });
    },
    onError: (error) => toast.error('Could not open the workspace', { description: errorMessage(error) }),
  });

  const accept = useMutation({
    mutationFn: () => api.inviteLinks.accept(token),
    onSuccess: async () => {
      // The server already made the workspace active on this session.
      queryClient.clear();
      toast.success(`Welcome to ${ws}`);
      await navigate({ to: '/' });
    },
    onError: async (error) => {
      if (!(error instanceof ApiRequestError)) return;
      if (error.status === 409) {
        const details = error.details as { organizationId?: string } | undefined;
        openWorkspace.mutate(details?.organizationId ?? link.organization.id);
      } else if (error.status === 410) {
        await queryClient.invalidateQueries({ queryKey: inviteLinkPreviewQuery(token).queryKey });
      } else if (error.status === 403) {
        setDomainBlocked(true);
      }
    },
  });

  const switchAccount = useMutation({
    mutationFn: async () => {
      await authClient.signOut();
      await queryClient.resetQueries({ queryKey: keys.me });
    },
  });

  if (isMember) {
    return (
      <StateCard
        action={
          <Button disabled={openWorkspace.isPending} onClick={() => openWorkspace.mutate(link.organization.id)} size="lg">
            {openWorkspace.isPending ? <Loader2Icon className="animate-spin" /> : null}
            Open {ws}
            {openWorkspace.isPending ? null : <ArrowRightIcon />}
          </Button>
        }
        description={`${me?.user.email} is already a member of ${ws} — there is nothing to accept.`}
        icon={CircleCheckIcon}
        testId="join-already-member"
        title={`You're already in ${ws}`}
        tone="success"
      />
    );
  }

  if (link.state !== 'active') return <ClosedLink link={link} me={me} />;

  const wrongDomain = Boolean(me && link.allowedDomain && emailDomain(me.user.email) !== link.allowedDomain.toLowerCase()) || domainBlocked;

  return (
    <div className="flex flex-col gap-6" data-testid="join-card">
      <div className="flex flex-col items-center gap-3 text-center">
        <EntityAvatar className="size-12 text-base" id={link.organization.id} name={ws} size="lg" square />
        <div className="flex flex-col gap-1">
          <h1 className="font-semibold text-2xl tracking-tight">Join {ws}</h1>
          <p className="text-muted-foreground text-sm">
            {link.inviter ? (
              <>
                <span className="font-medium text-foreground">{link.inviter.name}</span> invited you to their Logbird workspace.
              </>
            ) : (
              'You were invited to a Logbird workspace.'
            )}
          </p>
        </div>
      </div>

      <dl className="divide-y rounded-xl border bg-card text-sm shadow-xs">
        <DetailRow label="Role">
          <span className="flex flex-col items-end">
            <span className="font-medium">{roleLabel(link.role)}</span>
            <span className="text-end text-muted-foreground text-xs">{ROLE_INFO[link.role].description}</span>
          </span>
        </DetailRow>
        <DetailRow label="Who can join">
          {link.allowedDomain ? (
            <span className="font-medium">
              <span className="font-mono">@{link.allowedDomain}</span> emails only
            </span>
          ) : (
            <span className="font-medium">Anyone with this link</span>
          )}
        </DetailRow>
        <DetailRow label="Expires">
          <span title={formatFull(link.expiresAt)}>
            <Timestamp format="relative" iso={link.expiresAt} />
          </span>
        </DetailRow>
      </dl>

      {me === null ? (
        <JoinSignIn link={link} />
      ) : wrongDomain ? (
        <div className="flex flex-col gap-3">
          <p
            className="flex items-start gap-2 rounded-lg border border-outcome-denied/30 bg-outcome-denied/10 px-3 py-2.5 text-sm"
            data-testid="join-wrong-domain"
            role="alert"
          >
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-outcome-denied" />
            <span>
              This link only accepts <span className="font-medium">@{link.allowedDomain}</span> addresses. You are signed in as{' '}
              <span className="font-medium">{me.user.email}</span>.
            </span>
          </p>
          <Button disabled={switchAccount.isPending} onClick={() => switchAccount.mutate()} size="lg">
            {switchAccount.isPending ? <Loader2Icon className="animate-spin" /> : <LogOutIcon />}
            Use a different email
          </Button>
          {me.organizations.length > 0 ? (
            <Button nativeButton={false} render={<Link to="/" />} variant="ghost">
              Back to my workspace
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {accept.isError && !(accept.error instanceof ApiRequestError && [409, 410, 403].includes(accept.error.status)) ? (
            <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-sm" role="alert">
              {errorMessage(accept.error)}
            </p>
          ) : null}
          <Button data-testid="join-accept" disabled={accept.isPending || openWorkspace.isPending} onClick={() => accept.mutate()} size="lg">
            {accept.isPending ? <Loader2Icon className="animate-spin" /> : null}
            Join {ws}
            {accept.isPending ? null : <ArrowRightIcon />}
          </Button>
          <p className="text-center text-muted-foreground text-xs">
            Signed in as {me.user.email} ·{' '}
            <button
              className="underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
              disabled={switchAccount.isPending}
              onClick={() => switchAccount.mutate()}
              type="button"
            >
              use a different email
            </button>
          </p>
        </div>
      )}
    </div>
  );
}

const emailSchema = z.email('Enter a valid email address.');

/** Signed out: email a one-time code, verify on /login/verify, then come straight back here. */
function JoinSignIn({ link }: { link: InviteLinkPreview }) {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm({
    defaultValues: { email: '' },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const email = value.email.trim().toLowerCase();
      try {
        await sendSignInCode(email);
        markOtpSent(email);
        await navigate({ to: '/login/verify', search: { email, redirect: `/join/${token}` } });
      } catch (error) {
        setServerError(errorMessage(error));
      }
    },
  });
  const domain = link.allowedDomain?.toLowerCase() ?? null;

  return (
    <form
      className="flex flex-col gap-3"
      data-testid="join-sign-in"
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
            if (domain && emailDomain(value.trim()) !== domain) return `This link only accepts @${domain} addresses.`;
          },
        }}
      >
        {(field) => {
          const message = fieldErrorMessage(field.state.meta.errors);
          return (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="join-email">Work email</Label>
              <div className="relative">
                <MailIcon className="-translate-y-1/2 pointer-events-none absolute start-3 top-1/2 size-4 text-muted-foreground" />
                <Input
                  aria-describedby={message ? 'join-email-error' : undefined}
                  aria-invalid={Boolean(message) || undefined}
                  autoComplete="email"
                  className="ps-9"
                  id="join-email"
                  inputMode="email"
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder={domain ? `you@${domain}` : 'you@company.com'}
                  size="lg"
                  type="email"
                  value={field.state.value}
                />
              </div>
              {message ? (
                <p className="text-destructive text-xs" id="join-email-error">
                  {message}
                </p>
              ) : null}
            </div>
          );
        }}
      </form.Field>
      {serverError ? (
        <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-sm" role="alert">
          {serverError}
        </p>
      ) : null}
      <form.Subscribe selector={(s) => s.isSubmitting}>
        {(submitting) => (
          <Button disabled={submitting} size="lg" type="submit">
            {submitting ? <Loader2Icon className="animate-spin" /> : null}
            {submitting ? 'Sending code…' : 'Continue with email'}
            {submitting ? null : <ArrowRightIcon />}
          </Button>
        )}
      </form.Subscribe>
      <p className="text-center text-muted-foreground text-xs">
        We email you a 6-digit code. New to Logbird? The same code creates your account, then you come back here to join.
      </p>
    </form>
  );
}

function ClosedLink({ link, me }: { link: InviteLinkPreview; me: MeResponse | null }) {
  const who = link.inviter?.name ?? 'an admin';
  const ws = link.organization.name;
  const action = <OpenOrSignIn me={me} />;
  switch (link.state) {
    case 'expired':
      return (
        <StateCard
          action={action}
          description={`This link to ${ws} expired on ${formatFull(link.expiresAt)}. Ask ${who} for a new one — it takes them one click.`}
          icon={ClockIcon}
          testId="join-expired"
          title="This invite link has expired"
        />
      );
    case 'revoked':
      return (
        <StateCard
          action={action}
          description={`An admin of ${ws} turned this link off. Ask ${who} for a new one if you still need access.`}
          icon={CircleSlashIcon}
          testId="join-revoked"
          title="This invite link was revoked"
        />
      );
    default:
      return (
        <StateCard
          action={action}
          description={`This link to ${ws} was limited to a number of people, and they have all joined. Ask ${who} for a new one.`}
          icon={UsersIcon}
          testId="join-exhausted"
          title="This invite link is used up"
        />
      );
  }
}

function OpenOrSignIn({ me }: { me: MeResponse | null }) {
  if (me) {
    return (
      <Button nativeButton={false} render={<Link to="/" />} variant="outline">
        Open Logbird
        <ArrowRightIcon />
      </Button>
    );
  }
  return (
    <Button nativeButton={false} render={<Link to="/login" />} variant="outline">
      Sign in
      <ArrowRightIcon />
    </Button>
  );
}
