import type { InvitationPreview } from '@logbird/contracts';
import { EntityAvatar } from '@logbird/ui/components/entity-chip';
import { Button } from '@logbird/ui/components/ui/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowRightIcon, CircleAlertIcon, CircleCheckIcon, CircleSlashIcon, ClockIcon, Loader2Icon, LogOutIcon, MailIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { DetailRow, LoadingCard, PublicInviteLayout, StateCard } from '@/components/invite/public-invite';
import { Timestamp } from '@/components/timestamp';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import { invitationPreviewQuery, keys, meQuery } from '@/lib/api/queries';
import { authCall, authClient } from '@/lib/auth-client';
import { formatFull } from '@/lib/format';
import { ROLE_INFO, type Role, roleLabel } from '@/lib/organization';
import { markOtpSent } from '@/lib/otp';

/**
 * Public: works signed in or out. The invitation id in the URL is the secret, so the page never gets indexed.
 * Signed out → one click emails a code to the invited address and comes back here after verification.
 */
export const Route = createFileRoute('/accept-invitation/$invitationId')({
  head: () => ({ meta: [{ title: 'Join a workspace · Logbird' }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: AcceptInvitationPage,
});

function AcceptInvitationPage() {
  const { invitationId } = Route.useParams();
  const preview = useQuery(invitationPreviewQuery(invitationId));
  const session = useQuery({ ...meQuery(), retry: false });
  const loading = preview.isPending || session.isPending;

  let body: ReactNode;
  if (loading) body = <LoadingCard />;
  else if (preview.isError)
    body =
      preview.error instanceof ApiRequestError && preview.error.status === 404 ? (
        <StateCard
          description="The link may be mistyped, or the workspace was deleted. Ask the person who invited you for a new invitation."
          icon={CircleSlashIcon}
          title="Invitation not found"
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
          title="Could not load the invitation"
          tone="danger"
        />
      );
  else body = <Invitation invitation={preview.data} signedInAs={session.data?.user.email ?? null} />;

  return <PublicInviteLayout>{body}</PublicInviteLayout>;
}

function Invitation({ invitation, signedInAs }: { invitation: InvitationPreview; signedInAs: string | null }) {
  const { invitationId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const here = `/accept-invitation/${invitationId}`;
  const refresh = () => queryClient.invalidateQueries({ queryKey: invitationPreviewQuery(invitationId).queryKey });

  const signInAsInvited = useMutation({
    mutationFn: async () => {
      if (signedInAs) {
        await authClient.signOut();
        queryClient.removeQueries({ queryKey: keys.me });
      }
      await authCall(authClient.emailOtp.sendVerificationOtp({ email: invitation.email, type: 'sign-in' }));
      markOtpSent(invitation.email);
    },
    onSuccess: () => navigate({ to: '/login/verify', search: { email: invitation.email, redirect: here } }),
    onError: (error) => toast.error('Could not send the sign-in code', { description: errorMessage(error) }),
  });

  const accept = useMutation({
    mutationFn: async () => {
      await authCall(authClient.organization.acceptInvitation({ invitationId }));
      await authCall(authClient.organization.setActive({ organizationId: invitation.organization.id }));
    },
    onSuccess: async () => {
      queryClient.clear();
      toast.success(`Welcome to ${invitation.organization.name}`);
      await navigate({ to: '/' });
    },
    onError: () => refresh(),
  });
  const decline = useMutation({
    mutationFn: () => authCall(authClient.organization.rejectInvitation({ invitationId })),
    onSuccess: refresh,
    onError: (error) => toast.error('Could not decline the invitation', { description: errorMessage(error) }),
  });

  if (invitation.state !== 'pending') return <ClosedInvitation invitation={invitation} signedIn={Boolean(signedInAs)} />;

  const mismatch = signedInAs !== null && signedInAs.toLowerCase() !== invitation.email.toLowerCase();

  return (
    <div className="flex flex-col gap-6" data-testid="invitation-card">
      <div className="flex flex-col items-center gap-3 text-center">
        <EntityAvatar className="size-12 text-base" id={invitation.organization.id} name={invitation.organization.name} size="lg" square />
        <div className="flex flex-col gap-1">
          <h1 className="font-semibold text-2xl tracking-tight">Join {invitation.organization.name}</h1>
          <p className="text-muted-foreground text-sm">
            {invitation.inviter ? (
              <>
                <span className="font-medium text-foreground">{invitation.inviter.name}</span> invited you to their Logbird workspace.
              </>
            ) : (
              'You were invited to a Logbird workspace.'
            )}
          </p>
        </div>
      </div>

      <dl className="divide-y rounded-xl border bg-card text-sm shadow-xs">
        <DetailRow label="Invited email">
          <span className="font-medium">{invitation.email}</span>
        </DetailRow>
        <DetailRow label="Role">
          <span className="flex flex-col items-end">
            <span className="font-medium">{roleLabel(invitation.role)}</span>
            <span className="text-end text-muted-foreground text-xs">{ROLE_INFO[invitation.role as Role]?.description}</span>
          </span>
        </DetailRow>
        <DetailRow label="Expires">
          <Timestamp format="relative" iso={invitation.expiresAt} />
        </DetailRow>
      </dl>

      {signedInAs === null ? (
        <div className="flex flex-col gap-2">
          <Button size="lg" disabled={signInAsInvited.isPending} onClick={() => signInAsInvited.mutate()}>
            {signInAsInvited.isPending ? <Loader2Icon className="animate-spin" /> : <MailIcon />}
            Email me a sign-in code
          </Button>
          <p className="text-center text-muted-foreground text-xs">
            We send a 6-digit code to the invited email. New to Logbird? The same code creates your account, then you come back here to accept.
          </p>
        </div>
      ) : mismatch ? (
        <div className="flex flex-col gap-3">
          <p
            className="flex items-start gap-2 rounded-lg border border-outcome-denied/30 bg-outcome-denied/10 px-3 py-2.5 text-sm"
            data-testid="invitation-wrong-email"
            role="alert"
          >
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-outcome-denied" />
            <span>
              You are signed in as <span className="font-medium">{signedInAs}</span>, but this invitation is for{' '}
              <span className="font-medium">{invitation.email}</span>. Only that address can accept it.
            </span>
          </p>
          <Button size="lg" disabled={signInAsInvited.isPending} onClick={() => signInAsInvited.mutate()}>
            {signInAsInvited.isPending ? <Loader2Icon className="animate-spin" /> : <LogOutIcon />}
            Sign out and switch account
          </Button>
          <Button nativeButton={false} render={<Link to="/" />} variant="ghost">
            Back to my workspace
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {accept.isError ? (
            <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-sm" role="alert">
              {errorMessage(accept.error)}
            </p>
          ) : null}
          <Button size="lg" disabled={accept.isPending || decline.isPending} onClick={() => accept.mutate()}>
            {accept.isPending ? <Loader2Icon className="animate-spin" /> : null}
            Accept and join {invitation.organization.name}
            {accept.isPending ? null : <ArrowRightIcon />}
          </Button>
          <Button disabled={accept.isPending || decline.isPending} onClick={() => decline.mutate()} variant="ghost">
            {decline.isPending ? <Loader2Icon className="animate-spin" /> : null}
            Decline
          </Button>
          <p className="text-center text-muted-foreground text-xs">Signed in as {signedInAs}</p>
        </div>
      )}
    </div>
  );
}

function ClosedInvitation({ invitation, signedIn }: { invitation: InvitationPreview; signedIn: boolean }) {
  const go = signedIn ? (
    <Button nativeButton={false} render={<Link to="/" />}>
      Open Logbird
      <ArrowRightIcon />
    </Button>
  ) : (
    <Button nativeButton={false} render={<Link search={{ email: invitation.email }} to="/login" />}>
      Sign in
      <ArrowRightIcon />
    </Button>
  );
  const ws = invitation.organization.name;
  switch (invitation.state) {
    case 'accepted':
      return (
        <StateCard
          action={go}
          description={`${invitation.email} already joined ${ws}. Sign in with that address to open the workspace.`}
          icon={CircleCheckIcon}
          testId="invitation-accepted"
          title="Invitation already accepted"
          tone="success"
        />
      );
    case 'expired':
      return (
        <StateCard
          action={go}
          description={`This invitation to ${ws} expired on ${formatFull(invitation.expiresAt)}. Ask ${invitation.inviter?.name ?? 'an admin'} to send a new one — it takes them one click.`}
          icon={ClockIcon}
          testId="invitation-expired"
          title="This invitation has expired"
        />
      );
    case 'rejected':
      return (
        <StateCard
          action={go}
          description={`You declined the invitation to ${ws}. If that was a mistake, ask ${invitation.inviter?.name ?? 'an admin'} to invite you again.`}
          icon={CircleSlashIcon}
          testId="invitation-declined"
          title="Invitation declined"
        />
      );
    default:
      return (
        <StateCard
          action={go}
          description={`An admin of ${ws} withdrew this invitation. Ask them for a new one if you still need access.`}
          icon={CircleSlashIcon}
          testId="invitation-canceled"
          title="Invitation canceled"
        />
      );
  }
}
