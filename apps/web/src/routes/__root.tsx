import geistLatin from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url';
import { getThemeScript, ThemeProvider } from '@logbird/ui/theme';
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { type ReactNode, Suspense } from 'react';
import { NotFound } from '../components/not-found';
import { SiteFooter, SiteHeader } from '../components/site-shell';
import appCss from '../styles.css?url';
export const THEME_KEY = 'logbird.site.theme';
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#fafafa', media: '(prefers-color-scheme: light)' },
      { name: 'theme-color', content: '#0b0b0c', media: '(prefers-color-scheme: dark)' },
    ],
    links: [
      // Preload the Latin UI font so first paint already uses Geist (no swap repaint of the headline).
      { rel: 'preload', href: geistLatin, as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/brand/logbird-favicon.svg' },
      { rel: 'apple-touch-icon', href: '/brand/logbird-apple-touch-icon.png' },
      { rel: 'manifest', href: '/site.webmanifest' },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
  notFoundComponent: RootNotFound,
});
/**
 * Unknown paths are answered with the prerendered 404.html, which is the code-split /404 route (rendered inside a
 * Suspense boundary). The same boundary here keeps the hydrated tree identical to that HTML (src/routes/404.tsx).
 */
function RootNotFound() {
  return (
    <Suspense>
      <NotFound />
    </Suspense>
  );
}
function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static shared theme bootstrap */}
        <script dangerouslySetInnerHTML={{ __html: getThemeScript(THEME_KEY, 'system') }} />
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
  return (
    <ThemeProvider storageKey={THEME_KEY} defaultTheme="system">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
      <SiteFooter />
    </ThemeProvider>
  );
}
