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
  // Dev-only fixture mode (`pnpm dev:fixtures` or VITE_FIXTURES=1): fake transport + session, see src/dev/.
  const fixtures = mode === 'fixtures' || env.VITE_FIXTURES === '1';

  return {
    define: {
      'import.meta.env.VITE_FIXTURES': JSON.stringify(fixtures ? '1' : ''),
    },
    resolve: { tsconfigPaths: true },
    server: {
      port: 4600,
      proxy: fixtures
        ? undefined
        : {
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
          codeSplittingOptions: {
            defaultBehavior: [['component'], ['pendingComponent', 'errorComponent', 'notFoundComponent']],
          },
        },
      }),
      viteReact(),
    ],
  };
});
