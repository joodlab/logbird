import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Button } from '@trailmark/ui/components/ui/button';
import { ArrowRightIcon, Loader2Icon } from 'lucide-react';
import { useState } from 'react';
import { NameForm } from '@/components/account/name-form';
import { UserAvatar } from '@/components/account/user-avatar';
import { displayName } from '@/lib/user';

export const Route = createFileRoute('/_authed/onboarding/profile')({
  head: () => ({ meta: [{ title: 'Your name · Trailmark' }] }),
  component: ProfileStep,
});

function ProfileStep() {
  const { me } = Route.useRouteContext();
  const navigate = useNavigate();
  const [preview, setPreview] = useState(me.user.name ?? '');
  return (
    <div className="grid gap-10 md:grid-cols-[1fr_260px]">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-semibold text-2xl tracking-tight">What should we call you?</h1>
          <p className="text-muted-foreground text-sm">
            You signed in as <span className="font-medium text-foreground">{me.user.email}</span>. Add the name your team knows you by.
          </p>
        </div>
        <NameForm
          actions={({ submitting, canSubmit }) => (
            <div className="flex items-center gap-3">
              <Button className="h-10" disabled={submitting || !canSubmit} type="submit">
                {submitting ? <Loader2Icon className="animate-spin" /> : null}
                Continue
                {submitting ? null : <ArrowRightIcon />}
              </Button>
            </div>
          )}
          autoFocus
          initial={me.user.name ?? ''}
          inputClassName="h-10"
          onChange={setPreview}
          onSaved={() => navigate({ to: '/onboarding' })}
        />
      </div>
      <aside className="flex flex-col gap-3 rounded-xl border bg-card/60 p-4 text-sm shadow-xs">
        <p className="font-medium">How teammates see you</p>
        <div className="flex items-center gap-3 rounded-lg border bg-background p-3">
          <UserAvatar size="lg" user={{ ...me.user, name: preview }} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium" dir="auto">
              {displayName({ ...me.user, name: preview })}
            </span>
            <span className="truncate text-muted-foreground text-xs">{me.user.email}</span>
          </div>
        </div>
        <p className="text-muted-foreground text-xs">You can change it any time from Account settings.</p>
      </aside>
    </div>
  );
}
