import { Button } from '@logbird/ui/components/ui/button';
import { cn } from '@logbird/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { CheckIcon, LogOutIcon } from 'lucide-react';
import { useEffect } from 'react';
import { BrandLockup } from '@/components/brand';
import { workspaceSetupQuery } from '@/lib/api/queries';
import { signOut } from '@/lib/auth-client';
import { hasName } from '@/lib/user';

export const Route = createFileRoute('/_authed/onboarding')({
  head: () => ({ meta: [{ title: 'Get started · Logbird' }] }),
  component: OnboardingLayout,
});

const STEPS = [
  { id: 'profile', label: 'You', match: (p: string) => p.startsWith('/onboarding/profile') },
  { id: 'workspace', label: 'Workspace', match: (p: string) => p === '/onboarding' || p === '/onboarding/' },
  { id: 'project', label: 'Project', match: (p: string) => p.startsWith('/onboarding/project') },
  { id: 'first_event', label: 'First event', match: (p: string) => p.startsWith('/onboarding/first-event') },
] as const;

function OnboardingLayout() {
  const { me } = Route.useRouteContext();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = Math.max(
    0,
    STEPS.findIndex((s) => s.match(pathname)),
  );
  // Real state, not the URL: a step is done when the server says so, so coming back later shows true progress.
  const setup = useQuery({ ...workspaceSetupQuery(), enabled: me.organizations.length > 0 });
  const { refetch } = setup;
  // Each step changes what is done; re-read the summary whenever the step changes.
  useEffect(() => {
    if (pathname && me.organizations.length > 0) refetch();
  }, [pathname, me.organizations.length, refetch]);
  const done: Record<(typeof STEPS)[number]['id'], boolean> = {
    profile: hasName(me.user),
    workspace: me.organizations.length > 0,
    project: (setup.data?.projects.length ?? 0) > 0,
    first_event: setup.data?.projects.some((p) => p.firstEventAt) ?? false,
  };
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return (
    <div className="relative flex min-h-svh flex-col">
      <div
        aria-hidden
        className="tm-grid-bg pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_10%,transparent_60%)]"
      />
      <header className="relative flex h-16 items-center justify-between gap-4 px-6">
        <BrandLockup />
        <div className="flex items-center gap-3 text-muted-foreground text-sm">
          <span className="hidden sm:inline">{me.user.email}</span>
          <Button
            onClick={async () => {
              await signOut();
              queryClient.clear();
              await navigate({ to: '/login' });
            }}
            size="sm"
            variant="ghost"
          >
            <LogOutIcon />
            Sign out
          </Button>
        </div>
      </header>
      <main className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 pt-6 pb-16 sm:pt-10">
        <ol aria-label="Setup progress" className="flex items-center gap-2 text-sm">
          {STEPS.map((step, i) => {
            const isCurrent = i === current;
            const isDone = done[step.id] && !isCurrent;
            return (
              <li className="flex items-center gap-2" data-done={done[step.id] || undefined} key={step.id}>
                <span
                  aria-current={isCurrent ? 'step' : undefined}
                  className={cn(
                    'flex size-6 items-center justify-center rounded-full border font-medium text-xs tabular-nums transition-colors',
                    isDone && 'border-transparent bg-foreground text-background',
                    isCurrent && 'border-brand bg-brand/10 text-brand',
                    !isDone && !isCurrent && 'text-muted-foreground',
                  )}
                >
                  {isDone ? <CheckIcon className="size-3.5" /> : i + 1}
                </span>
                <span className={cn('hidden sm:inline', isCurrent ? 'font-medium text-foreground' : 'text-muted-foreground')}>{step.label}</span>
                {isCurrent ? <span className="font-medium text-foreground sm:hidden">{step.label}</span> : null}
                {i < STEPS.length - 1 ? <span aria-hidden className="mx-1 h-px w-4 bg-border sm:w-10" /> : null}
              </li>
            );
          })}
        </ol>
        <div className="tm-fade-in">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
