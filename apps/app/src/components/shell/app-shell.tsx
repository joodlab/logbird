import { SidebarInset, SidebarProvider } from '@trailmark/ui/components/ui/sidebar';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { CrumbProvider } from '@/lib/crumbs';
import { AppSidebar } from './app-sidebar';
import { BusyNotice } from './busy-notice';
import { CommandPalette } from './command-palette';
import { TopBar } from './top-bar';

/** Signed-in chrome: collapsible sidebar, breadcrumb top bar with the shared range, ⌘K palette. */
export function AppShell({ projectId, children }: { projectId?: string; children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <CrumbProvider>
      {/* Inset layout (as in our reference app): the sidebar sits on the muted sidebar surface and the page is a floating rounded
          panel. The shell is exactly one viewport tall; pages scroll inside #app-main so the panel never moves. */}
      <SidebarProvider className="h-svh overflow-hidden" style={{ '--sidebar-width': '15rem' } as CSSProperties}>
        {/* First tab stop: keyboard users skip the sidebar and the top bar. */}
        <button
          className="-translate-y-[200%] fixed start-3 top-3 z-50 rounded-md border bg-popover px-3 py-2 font-medium text-popover-foreground text-sm shadow-md outline-none ring-3 ring-ring/40 transition-transform focus:translate-y-0"
          onClick={() => document.getElementById('app-main')?.focus()}
          type="button"
        >
          Skip to content
        </button>
        <AppSidebar projectId={projectId} />
        <SidebarInset className="min-w-0 overflow-hidden md:peer-data-[variant=inset]:border md:peer-data-[variant=inset]:border-border/80">
          <TopBar onOpenPalette={() => setPaletteOpen(true)} />
          <BusyNotice />
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain outline-none"
            data-scroll-restoration-id="app-main"
            id="app-main"
            tabIndex={-1}
          >
            {children}
          </div>
        </SidebarInset>
        <CommandPalette onOpenChange={setPaletteOpen} open={paletteOpen} projectId={projectId} />
      </SidebarProvider>
    </CrumbProvider>
  );
}
