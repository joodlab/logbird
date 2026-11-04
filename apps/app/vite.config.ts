import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig, loadEnv } from 'vite';

/**
 * The console talks to exactly one origin. In dev, Vite proxies `/api` (better-auth + internal API)
 * and `/v1` (public API) to the Hono server so the better-auth session cookie stays first-party.
 * The production Nitro server does the same through route rules.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const rootEnv = loadEnv(mode, '../..', '');
  const serverTarget = env.TRAILMARK_SERVER_URL ?? rootEnv.SERVER_URL?.replace('localhost', '127.0.0.1') ?? 'http://127.0.0.1:4601';

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
        routeRules: {
          '/api/**': { proxy: `${serverTarget}/api/**` },
          '/v1/**': { proxy: `${serverTarget}/v1/**` },
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
