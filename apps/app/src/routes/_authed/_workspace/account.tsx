import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { CopyValue } from '@trailmark/ui/components/copy-button';
import { PageHeader } from '@trailmark/ui/components/page-header';
import { Button } from '@trailmark/ui/components/ui/button';
import { Loader2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { NameForm } from '@/components/account/name-form';
import { UserAvatar } from '@/components/account/user-avatar';
import { SettingsSection } from '@/components/settings-section';
import { AppShell } from '@/components/shell/app-shell';
import { meQuery } from '@/lib/api/queries';
import { lastProject } from '@/lib/session';
import { displayName, hasName } from '@/lib/user';

export const Route = createFileRoute('/_authed/_workspace/account')({
  staticData: { crumb: 'Account' },
  head: () => ({ meta: [{ title: 'Account · Trailmark' }] }),
  component: AccountPage,
});

function AccountPage() {
  const { me: initialMe, workspace } = Route.useRouteContext();
  const me = useQuery({ ...meQuery(), initialData: initialMe });
  const user = me.data.user;
  const [preview, setPreview] = useState<string | null>(null);
  const shown = { ...user, name: preview ?? user.name };
  // Keep the project nav in the sidebar when coming from a project.
  const projectId = typeof window === 'undefined' ? undefined : (lastProject() ?? undefined);
  const inWorkspace = me.data.organizations.some((o) => o.id === workspace.id);
  return (
    <AppShell projectId={inWorkspace ? projectId : undefined}>
      <div className="flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6">
        <PageHeader description="How you appear to your teammates across every workspace." title="Account" />
        <SettingsSection
          description={
            hasName(user)
              ? 'Change the name your teammates see. Your initials avatar follows it everywhere.'
              : 'You signed in with a code, so Trailmark only knows your email. Add the name your team knows you by.'
          }
          title="Profile"
        >
          <div className="flex items-center gap-3">
            <UserAvatar size="lg" user={shown} />
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-medium" dir="auto">
                {displayName(shown)}
              </span>
              <span className="truncate text-muted-foreground text-sm">{user.email}</span>
            </div>
          </div>
          <NameForm
            actions={({ dirty, submitting, canSubmit, reset }) => (
              <div className="-mx-5 -mb-5 flex items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
                {dirty ? (
                  <Button
                    onClick={() => {
                      reset();
                      setPreview(null);
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Discard
                  </Button>
                ) : null}
                <Button disabled={!dirty || submitting || !canSubmit} size="sm" type="submit">
                  {submitting ? <Loader2Icon className="animate-spin" /> : null}
                  Save name
                </Button>
              </div>
            )}
            initial={user.name ?? ''}
            key={user.name}
            onChange={setPreview}
            onSaved={() => {
              setPreview(null);
              toast.success('Name updated');
            }}
          />
        </SettingsSection>
        <SettingsSection description="You sign in with a one-time code sent to this address. There is no password to manage." title="Sign-in email">
          <div className="flex max-w-md flex-col gap-1.5">
            <CopyValue value={user.email} />
          </div>
        </SettingsSection>
      </div>
    </AppShell>
  );
}
