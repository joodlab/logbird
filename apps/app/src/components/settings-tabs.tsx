import { cn } from '@logbird/ui/lib/utils';
import { Link, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { logicalScroll, logicalTabSpan, physicalScroll, revealScroll, stripEdges, stripMask } from '@/lib/tab-strip';

/** Width of the edge fade that tells a phone user the tab strip scrolls. */
const FADE = 28;

/**
 * Scroll only the strip (scrollIntoView would also scroll the page): bring `tab` fully into view, clear of the fades.
 */
function revealTab(nav: HTMLElement, tab: HTMLElement) {
  const rtl = getComputedStyle(nav).direction === 'rtl';
  const scroll = logicalScroll(nav.scrollLeft);
  const span = logicalTabSpan(nav.getBoundingClientRect(), tab.getBoundingClientRect(), scroll, rtl);
  const target = revealScroll(span, { scroll, width: nav.clientWidth, scrollWidth: nav.scrollWidth }, FADE);
  if (target !== null) nav.scrollLeft = physicalScroll(target, rtl);
}

/**
 * Keeps the active section — and the tab keyboard focus is on — visible in a horizontally scrolling tab strip (phones), and fades the edge that has more
 * tabs behind it. Works in logical coordinates, so an RTL strip scrolls and fades from its right-hand start.
 */
export function useTabStrip(activeKey: string) {
  const ref = useRef<HTMLElement>(null);
  const [state, setState] = useState({ start: false, end: false, rtl: false });
  useEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const update = () => {
      const rtl = getComputedStyle(nav).direction === 'rtl';
      const edges = stripEdges({ scroll: logicalScroll(nav.scrollLeft), width: nav.clientWidth, scrollWidth: nav.scrollWidth });
      setState((prev) => (prev.start === edges.start && prev.end === edges.end && prev.rtl === rtl ? prev : { ...edges, rtl }));
    };
    update();
    nav.addEventListener('scroll', update, { passive: true });
    // Tabbing to an inactive tab: the browser scrolls it only to the edge, under the fade (and its focus ring with it).
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== nav) revealTab(nav, event.target);
    };
    nav.addEventListener('focusin', onFocusIn);
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    return () => {
      nav.removeEventListener('scroll', update);
      nav.removeEventListener('focusin', onFocusIn);
      observer.disconnect();
    };
  }, []);
  const router = useRouter();
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the active section changes
  useEffect(() => {
    const reveal = () => {
      const nav = ref.current;
      const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
      if (nav && active) revealTab(nav, active);
    };
    reveal();
    // The router's scroll restoration carries the strip's previous offset over to the new location and applies it on
    // `onRendered`, possibly after this effect: check again then (it subscribed first, so it has already run).
    return router.subscribe('onRendered', reveal);
  }, [activeKey, router]);
  const mask = stripMask(state, FADE, state.rtl);
  return { ref, style: mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined };
}

/** One settings section: a link (`to` + `params`) and its label. */
export interface SettingsTab {
  to: string;
  params?: Record<string, string>;
  label: string;
  /** Danger zone: hovers red. */
  danger?: boolean;
}

/**
 * The tab strip under a settings page title (project settings, workspace settings): one tab per section, the current one
 * underlined, scrolling sideways with edge fades on phones.
 */
export function SettingsTabs({ label, tabs, pathname }: { label: string; tabs: readonly SettingsTab[]; pathname: string }) {
  const strip = useTabStrip(pathname);
  return (
    <nav aria-label={label} className="-mb-px mt-3 flex gap-1 overflow-x-auto" ref={strip.ref} style={strip.style}>
      {tabs.map((tab) => {
        const href = Object.entries(tab.params ?? {}).reduce((h, [k, v]) => h.replace(`$${k}`, v), tab.to);
        const active = pathname === href;
        return (
          <Link
            // Exact: otherwise the router marks a section that is a prefix of the others (General) aria-current too.
            activeOptions={{ exact: true }}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative shrink-0 whitespace-nowrap rounded-t-md px-3 pt-1 pb-2.5 text-sm outline-none focus-visible:outline-hidden transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:forced-colors:-outline-offset-2 pointer-coarse:pt-2.5 pointer-coarse:pb-3.5',
              active
                ? 'font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand'
                : 'text-muted-foreground',
              tab.danger && !active && 'hover:text-destructive',
            )}
            key={tab.to}
            params={tab.params as never}
            to={tab.to as never}
          >
            {/* The active tab is medium weight: an invisible medium copy reserves that width, so tabs never shift. */}
            <span className="inline-grid justify-items-center">
              <span className="col-start-1 row-start-1">{tab.label}</span>
              <span aria-hidden className="invisible col-start-1 row-start-1 font-medium">
                {tab.label}
              </span>
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
