import { SidebarInset, SidebarProvider } from '@trailmark/ui/components/ui/sidebar';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { CrumbProvider } from '@/lib/crumbs';
import { AppSidebar } from './app-sidebar';
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
      <SidebarProvider style={{ '--sidebar-width': '15.5rem' } as CSSProperties}>
        <AppSidebar projectId={projectId} />
        <SidebarInset className="min-w-0">
          <TopBar onOpenPalette={() => setPaletteOpen(true)} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        </SidebarInset>
        <CommandPalette onOpenChange={setPaletteOpen} open={paletteOpen} projectId={projectId} />
      </SidebarProvider>
    </CrumbProvider>
  );
}
