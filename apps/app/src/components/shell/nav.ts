import {
  BookmarkIcon,
  BookOpenIcon,
  Building2Icon,
  CogIcon,
  LayoutDashboardIcon,
  ListTreeIcon,
  type LucideIcon,
  PackageIcon,
  Rows3Icon,
  SettingsIcon,
  UserIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  keywords?: string;
}

/** Project navigation, shared by the sidebar and the command palette. */
export const PROJECT_NAV: { group: string | null; items: NavItem[] }[] = [
  {
    group: null,
    items: [
      { to: '/p/$projectId', label: 'Overview', icon: LayoutDashboardIcon, exact: true, keywords: 'dashboard home kpi' },
      { to: '/p/$projectId/events', label: 'Explorer', icon: Rows3Icon, keywords: 'events search logs query' },
    ],
  },
  {
    group: 'Follow',
    items: [
      { to: '/p/$projectId/actors', label: 'Actors', icon: UserIcon, keywords: 'users people who' },
      { to: '/p/$projectId/tenants', label: 'Tenants', icon: Building2Icon, keywords: 'customers accounts businesses' },
      { to: '/p/$projectId/workers', label: 'Executors', icon: CogIcon, keywords: 'workers jobs queues cron schedulers webhooks api' },
      { to: '/p/$projectId/records', label: 'Records', icon: PackageIcon, keywords: 'targets objects' },
    ],
  },
  {
    group: 'Data',
    items: [
      { to: '/p/$projectId/views', label: 'Saved views', icon: BookmarkIcon, keywords: 'views bookmarks filters' },
      { to: '/p/$projectId/fields', label: 'Fields', icon: ListTreeIcon, keywords: 'schema conformance attributes' },
    ],
  },
  {
    group: 'Project',
    items: [
      { to: '/p/$projectId/docs', label: 'Quickstart', icon: BookOpenIcon, keywords: 'docs sdk query language help' },
      { to: '/p/$projectId/settings', label: 'Settings', icon: SettingsIcon, keywords: 'retention keys members danger' },
    ],
  },
];
