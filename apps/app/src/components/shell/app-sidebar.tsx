import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { EntityAvatar } from '@trailmark/ui/components/entity-chip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@trailmark/ui/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from '@trailmark/ui/components/ui/sidebar';
import { useTheme } from '@trailmark/ui/theme';
import {
  ActivityIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  FolderPlusIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SunIcon,
  UserIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { UserAvatar } from '@/components/account/user-avatar';
import { BrandMark } from '@/components/brand';
import { SetupProgress } from '@/components/setup/setup-progress';
import { meQuery, projectsQuery, viewsQuery } from '@/lib/api/queries';
import { authCall, authClient } from '@/lib/auth-client';
import { canDo } from '@/lib/permissions';
import { displayName, hasName } from '@/lib/user';
import { PROJECT_NAV } from './nav';

export function AppSidebar({ projectId }: { projectId?: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { setOpenMobile, isMobile } = useSidebar();
  const closeMobile = () => isMobile && setOpenMobile(false);
  const views = useQuery({ ...viewsQuery(projectId ?? ''), enabled: Boolean(projectId) });

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="gap-1">
        <WorkspaceSwitcher projectId={projectId} />
      </SidebarHeader>
      <SidebarContent className="gap-0 py-1">
        {projectId ? (
          PROJECT_NAV.map((section) => (
            <SidebarGroup className="py-1.5" key={section.group ?? 'main'}>
              {section.group ? <SidebarGroupLabel className="h-7 text-[11px] uppercase tracking-wider">{section.group}</SidebarGroupLabel> : null}
              <SidebarMenu className="gap-0.5">
                {section.items.map((item) => {
                  const href = item.to.replace('$projectId', projectId);
                  const active = item.exact ? pathname === href || pathname === `${href}/` : pathname === href || pathname.startsWith(`${href}/`);
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        className="h-8"
                        isActive={active}
                        onClick={closeMobile}
                        render={<Link params={{ projectId }} to={item.to} />}
                        tooltip={item.label}
                      >
                        <item.icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                      {item.to === '/p/$projectId/views' && (views.data?.length ?? 0) > 0 ? (
                        <SidebarMenuSub>
                          {views.data?.slice(0, 6).map((view) => (
                            <SidebarMenuSubItem key={view.id}>
                              <SidebarMenuSubButton
                                onClick={closeMobile}
                                render={
                                  <Link
                                    params={{ projectId }}
                                    search={{
                                      q: view.state.q || undefined,
                                      lang: view.state.lang === 'sql' ? ('sql' as const) : undefined,
                                      range: view.state.range,
                                      cols: view.state.columns?.join(',') || undefined,
                                      view: view.id,
                                    }}
                                    to="/p/$projectId/events"
                                  />
                                }
                                size="sm"
                              >
                                <span>{view.name}</span>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          ))
        ) : (
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive render={<Link to="/projects" />} tooltip="Projects">
                  <FolderPlusIcon />
                  <span>Projects</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          {projectId ? <SetupProgress projectId={projectId} /> : null}
          {projectId ? (
            <SidebarMenuItem>
              <SidebarMenuButton
                className="h-8"
                isActive={pathname.endsWith('/settings/activity')}
                onClick={closeMobile}
                render={<Link params={{ projectId }} to="/p/$projectId/settings/activity" />}
                tooltip="Workspace activity"
              >
                <ActivityIcon />
                <span>Workspace activity</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          <UserMenu />
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function WorkspaceSwitcher({ projectId }: { projectId?: string }) {
  const me = useQuery(meQuery());
  const projects = useQuery(projectsQuery());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const workspace = me.data?.organizations.find((o) => o.id === me.data?.activeOrganizationId);
  const project = projects.data?.find((p) => p.id === projectId);
  const canCreateProject = canDo(workspace?.role, 'project.create');

  const switchWorkspace = async (organizationId: string) => {
    try {
      await authCall(authClient.organization.setActive({ organizationId }));
      queryClient.clear();
      await navigate({ to: '/' });
    } catch (error) {
      toast.error('Could not switch workspace', { description: error instanceof Error ? error.message : undefined });
    }
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton className="h-11 data-popup-open:bg-sidebar-accent" size="lg">
                <BrandMark className="size-7 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col text-start leading-tight">
                  <span className="truncate font-semibold text-[13px] text-sidebar-accent-foreground">{project?.name ?? 'Select a project'}</span>
                  <span className="truncate text-[11px] text-muted-foreground">{workspace?.name ?? 'Workspace'}</span>
                </span>
                <ChevronsUpDownIcon className="ms-auto size-4 text-muted-foreground" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-[11px] uppercase tracking-wider">Projects in {workspace?.name}</DropdownMenuLabel>
              {projects.data?.map((p) => (
                <DropdownMenuItem key={p.id} onClick={() => navigate({ to: '/p/$projectId', params: { projectId: p.id } })}>
                  <EntityAvatar id={p.id} name={p.name} size="sm" square />
                  <span className="flex-1 truncate">{p.name}</span>
                  {p.id === projectId ? <CheckIcon className="size-4 text-brand" /> : null}
                </DropdownMenuItem>
              ))}
              {canCreateProject ? (
                <DropdownMenuItem onClick={() => navigate({ to: '/onboarding/project' })}>
                  <PlusIcon />
                  New project
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <EntityAvatar id={workspace?.id ?? ''} name={workspace?.name ?? ''} size="sm" square />
                <span className="flex-1 truncate">Switch workspace</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56">
                {me.data?.organizations.map((org) => (
                  <DropdownMenuItem key={org.id} onClick={() => org.id !== workspace?.id && switchWorkspace(org.id)}>
                    <EntityAvatar id={org.id} name={org.name} size="sm" square />
                    <span className="flex-1 truncate">{org.name}</span>
                    {org.id === workspace?.id ? <CheckIcon className="size-4 text-brand" /> : null}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate({ to: '/onboarding', search: { another: true } })}>
                  <PlusIcon />
                  New workspace
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onClick={() => navigate({ to: '/projects' })}>
              <FolderPlusIcon />
              All projects
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function UserMenu() {
  const me = useQuery(meQuery());
  const { theme, setTheme } = useTheme();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const user = me.data?.user;
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuButton className="h-10 data-popup-open:bg-sidebar-accent" size="lg">
              <UserAvatar size="md" user={user} />
              <span className="flex min-w-0 flex-1 flex-col text-start leading-tight">
                <span className="truncate font-medium text-[13px] text-sidebar-accent-foreground" dir="auto">
                  {displayName(user)}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">{user?.email}</span>
              </span>
              <ChevronsUpDownIcon className="ms-auto size-4 text-muted-foreground" />
            </SidebarMenuButton>
          }
        />
        <DropdownMenuContent align="start" className="w-60" side="top">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex items-center gap-2.5 font-normal">
              <UserAvatar size="md" user={user} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-foreground text-sm" dir="auto">
                  {displayName(user)}
                </span>
                <span className="truncate text-muted-foreground text-xs">{user?.email}</span>
              </span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem render={<Link to="/account" />}>
              <UserIcon />
              {hasName(user) ? 'Account settings' : 'Add your name'}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wider">Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup onValueChange={(value) => setTheme(value as 'light' | 'dark' | 'system')} value={theme}>
              <DropdownMenuRadioItem value="light">
                <SunIcon />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <MoonIcon />
                Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <MonitorIcon />
                System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<a href="https://github.com/joodlab/trailmark/blob/master/docs/SPEC.md" rel="noreferrer" target="_blank" />}>
            <BookOpenIcon />
            Product spec
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={async () => {
              await authClient.signOut();
              queryClient.clear();
              await navigate({ to: '/login' });
            }}
          >
            <LogOutIcon />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}
