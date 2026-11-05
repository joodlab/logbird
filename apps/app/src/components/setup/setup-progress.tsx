import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@trailmark/ui/components/ui/sidebar';
import { projectSetupQuery } from '@/lib/api/queries';
import { ProgressRing, stepCopy } from './steps';

/**
 * Compact "Setup 5/8" item for the project sidebar. Links to the Setup page (which can also re-open a dismissed
 * overview checklist); hidden once every step is done. In icon mode the ring stays and the tooltip says what is next.
 */
export function SetupProgress({ projectId }: { projectId: string }) {
  const setup = useQuery(projectSetupQuery(projectId));
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const data = setup.data;
  if (!data || data.complete) return null;
  const { done, total } = data.progress;
  const next = data.nextStep ? stepCopy(data.nextStep, data, 'todo').title : null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="h-9"
        data-testid="sidebar-setup-progress"
        isActive={pathname.endsWith('/setup')}
        onClick={() => isMobile && setOpenMobile(false)}
        render={<Link params={{ projectId }} to="/p/$projectId/setup" />}
        tooltip={next ? `Setup ${done}/${total} · next: ${next}` : `Setup ${done}/${total}`}
      >
        <ProgressRing done={done} size={16} total={total} />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate">Finish setup</span>
          {next ? <span className="truncate text-[11px] text-muted-foreground">Next: {next}</span> : null}
        </span>
        <span className="ms-auto font-medium text-[11px] text-muted-foreground tabular-nums">
          {done}/{total}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
