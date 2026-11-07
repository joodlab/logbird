import { cn } from '@logbird/ui/lib/utils';
import { createFileRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings')({
  staticData: { crumb: 'Settings' },
  head: () => ({ meta: [{ title: 'Settings · Logbird' }] }),
  component: SettingsLayout,
});

/** Width of the edge fade that tells a phone user the tab strip scrolls. */
const FADE = 28;

/**
 * Keeps the active section visible in a horizontally scrolling tab strip (phones), and fades the edge that has more
 * tabs behind it.
 */
function useTabStrip(activeKey: string) {
  const ref = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const update = () => {
      // scrollLeft is negative in RTL: compare magnitudes.
      const left = Math.abs(nav.scrollLeft);
      const max = nav.scrollWidth - nav.clientWidth;
      setEdges({ start: left > 1, end: max - left > 1 });
    };
    update();
    nav.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    return () => {
      nav.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the active section changes
  useEffect(() => {
    const nav = ref.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    // Scroll only the strip (scrollIntoView would also scroll the page): bring the active tab fully into view, clear of
    // the fades.
    const start = active.offsetLeft - nav.offsetLeft;
    const end = start + active.offsetWidth;
    if (start - FADE < nav.scrollLeft) nav.scrollLeft = Math.max(0, start - FADE);
    else if (end + FADE > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = end + FADE - nav.clientWidth;
  }, [activeKey]);
  const mask =
    edges.start || edges.end
      ? `linear-gradient(to right, ${edges.start ? 'transparent' : '#000'}, #000 ${FADE}px, #000 calc(100% - ${FADE}px), ${edges.end ? 'transparent' : '#000'})`
      : undefined;
  return { ref, style: mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined };
}

const TABS = [
  { to: '/p/$projectId/settings', label: 'General', exact: true },
  { to: '/p/$projectId/settings/retention', label: 'Retention' },
  { to: '/p/$projectId/settings/keys', label: 'API keys' },
  { to: '/p/$projectId/settings/members', label: 'Members' },
  { to: '/p/$projectId/settings/activity', label: 'Workspace activity' },
  { to: '/p/$projectId/settings/danger', label: 'Danger zone' },
] as const;

function SettingsLayout() {
  const { projectId } = Route.useParams();
  const pathname = useRouterState({ select: (s) => s.location.pathname.replace(/\/$/, '') });
  const isActivity = pathname.endsWith('/settings/activity');
  const strip = useTabStrip(pathname);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-4 pt-5 sm:px-6">
        <h1 className="font-semibold text-xl tracking-tight">Settings</h1>
        <nav aria-label="Settings sections" className="-mb-px mt-3 flex gap-1 overflow-x-auto" ref={strip.ref} style={strip.style}>
          {TABS.map((tab) => {
            const href = tab.to.replace('$projectId', projectId);
            const active = 'exact' in tab ? pathname === href : pathname === href;
            return (
              <Link
                // Exact: otherwise the router marks General (a prefix of every section) aria-current too.
                activeOptions={{ exact: true }}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative shrink-0 whitespace-nowrap rounded-t-md px-3 pt-1 pb-2.5 text-sm outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset pointer-coarse:pt-2.5 pointer-coarse:pb-3.5',
                  active
                    ? 'font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand'
                    : 'text-muted-foreground',
                  tab.label === 'Danger zone' && !active && 'hover:text-destructive',
                )}
                key={tab.to}
                params={{ projectId }}
                to={tab.to}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className={cn('w-full', isActivity ? 'flex min-h-0 flex-1 flex-col' : 'max-w-4xl p-4 sm:p-6')}>
        <Outlet />
      </div>
    </div>
  );
}
