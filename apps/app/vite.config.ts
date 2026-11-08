import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig, loadEnv } from 'vite';
import { apiReferenceContentSecurityPolicy } from './server/proxy-paths';

/**
 * The console talks to exactly one origin. The Nitro middleware (server/proxy.ts) forwards `/api` (better-auth +
 * internal API), `/v1` (public API), health checks and the read-only `/docs` + `/openapi.json` reference to the Hono
 * server, so the better-auth session cookie stays first-party; it reads its target at runtime in production.
 * The reference is GET/HEAD-only and forwarded without Cookie/Authorization (server/proxy-paths.ts). The Vite proxy
 * below is a fallback for `/api` and `/v1` only; the reference and health paths deliberately go through Nitro alone.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const rootEnv = loadEnv(mode, '../..', '');
  const serverTarget =
    // `||`, not `??`: .env.example ships an empty LOGBIRD_SERVER_URL= (the production runtime proxy target).
    process.env.LOGBIRD_SERVER_URL || env.LOGBIRD_SERVER_URL || rootEnv.SERVER_URL?.replace('localhost', '127.0.0.1') || 'http://127.0.0.1:4601';

  return {
    resolve: { tsconfigPaths: true },
    // Pre-bundle the heavy client deps up front so the first visit never hits a mid-session
    // "optimized dependencies changed" reload.
    optimizeDeps: {
      include: [
        'recharts',
        'react-day-picker',
        'cmdk',
        'input-otp',
        'sonner',
        'lucide-react',
        'better-auth/react',
        'better-auth/client/plugins',
        '@tanstack/react-table',
        '@tanstack/react-virtual',
        '@tanstack/react-form',
        '@tanstack/react-pacer',
        '@base-ui/react/button',
        '@base-ui/react/collapsible',
        '@base-ui/react/dialog',
        '@base-ui/react/alert-dialog',
        '@base-ui/react/input',
        '@base-ui/react/menu',
        '@base-ui/react/merge-props',
        '@base-ui/react/popover',
        '@base-ui/react/scroll-area',
        '@base-ui/react/separator',
        '@base-ui/react/switch',
        '@base-ui/react/tabs',
        '@base-ui/react/toggle',
        '@base-ui/react/toggle-group',
        '@base-ui/react/tooltip',
        '@base-ui/react/use-render',
        'class-variance-authority',
        'clsx',
        'tailwind-merge',
        'zod',
      ],
    },
    server: {
      port: 4600,
      proxy: {
        '/api': { target: serverTarget, changeOrigin: false },
        '/v1': { target: serverTarget, changeOrigin: false },
      },
    },
    plugins: [
      tailwindcss(),
      nitro({
        handlers: [{ route: '/**', handler: './server/proxy.ts', middleware: true }],
        routeRules: {
          '/**': {
            headers: {
              'Content-Security-Policy':
                "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
              'X-Content-Type-Options': 'nosniff',
              'Referrer-Policy': 'strict-origin-when-cross-origin',
            },
          },
          // The proxied API reference loads its pinned UI script from jsDelivr; only this page allows it.
          '/docs': { headers: { 'Content-Security-Policy': apiReferenceContentSecurityPolicy } },
        },
      }),
      tanstackStart({
        router: {
          // Only page components are split. Pending/error/not-found components stay in the route chunk:
          // they can render before a lazy chunk resolves, and a lazily loaded one trips React's
          // "use() suspended in a previous render" warning.
          codeSplittingOptions: { defaultBehavior: [['component']] },
        },
      }),
      viteReact(),
    ],
  };
});
