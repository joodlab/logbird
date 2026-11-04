import { QueryClientProvider } from '@tanstack/react-query';
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { ConfirmProvider } from '@trailmark/ui/components/ui/confirm';
import { Toaster } from '@trailmark/ui/components/ui/sonner';
import { TooltipProvider } from '@trailmark/ui/components/ui/tooltip';
import { getThemeScript, THEME_STORAGE_KEY, ThemeProvider } from '@trailmark/ui/theme';
import type { ReactNode } from 'react';
import { FixtureBanner } from '@/components/fixture-banner';
import type { RouterContext } from '@/router';
import appCss from '@/styles.css?url';

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: 'Trailmark' },
      { name: 'description', content: 'Open-source audit log and activity history console.' },
      { name: 'robots', content: 'noindex' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply the stored theme before first paint (the app itself renders client-side). */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static, self-authored theme bootstrap */}
        <script dangerouslySetInnerHTML={{ __html: getThemeScript(THEME_STORAGE_KEY, 'system') }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delay={300}>
          <ConfirmProvider labels={{ cancel: 'Cancel', delete: 'Delete', save: 'Save' }}>
            <Outlet />
          </ConfirmProvider>
          <FixtureBanner />
          <Toaster closeButton position="bottom-right" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
