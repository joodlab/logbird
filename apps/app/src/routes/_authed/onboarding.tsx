import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Button } from '@trailmark/ui/components/ui/button';
import { cn } from '@trailmark/ui/lib/utils';
import { CheckIcon, LogOutIcon } from 'lucide-react';
import { BrandLockup } from '@/components/brand';
import { authClient } from '@/lib/auth-client';

export const Route = createFileRoute('/_authed/onboarding')({
  head: () => ({ meta: [{ title: 'Get started · Trailmark' }] }),
  component: OnboardingLayout,
});

const STEPS = [
  { id: 'you', label: 'You', match: (p: string) => p.startsWith('/onboarding/profile') },
  { id: 'workspace', label: 'Workspace', match: (p: string) => p === '/onboarding' || p === '/onboarding/' },
  { id: 'project', label: 'Project', match: (p: string) => p.startsWith('/onboarding/project') },
  { id: 'event', label: 'First event', match: (p: string) => p.startsWith('/onboarding/first-event') },
];

function OnboardingLayout() {
  const { me } = Route.useRouteContext();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = Math.max(
    0,
    STEPS.findIndex((s) => s.match(pathname)),
  );
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
              await authClient.signOut();
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
          {STEPS.map((step, i) => (
            <li className="flex items-center gap-2" key={step.id}>
              <span
                aria-current={i === current ? 'step' : undefined}
                className={cn(
                  'flex size-6 items-center justify-center rounded-full border font-medium text-xs tabular-nums transition-colors',
                  i < current && 'border-transparent bg-foreground text-background',
                  i === current && 'border-brand bg-brand/10 text-brand',
                  i > current && 'text-muted-foreground',
                )}
              >
                {i < current ? <CheckIcon className="size-3.5" /> : i + 1}
              </span>
              <span className={cn(i === current ? 'font-medium text-foreground' : 'text-muted-foreground')}>{step.label}</span>
              {i < STEPS.length - 1 ? <span aria-hidden className="mx-1 h-px w-6 bg-border sm:w-10" /> : null}
            </li>
          ))}
        </ol>
        <div className="tm-fade-in">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
