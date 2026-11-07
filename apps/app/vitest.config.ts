import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Unit tests only need path aliases, not the Start/Nitro plugins in vite.config.ts. */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    dedupe: ['react', 'react-dom'],
    // Component tests: the use-sync-external-store shims (under TanStack Table and Base UI) would otherwise load a second,
    // nested React (see src/test/with-selector.ts); their importers are inlined so these aliases apply.
    alias: [
      {
        find: /^use-sync-external-store\/shim\/with-selector(\.js)?$/,
        replacement: fileURLToPath(new URL('./src/test/with-selector.ts', import.meta.url)),
      },
      {
        find: /^use-sync-external-store\/shim(\/index\.js)?$/,
        replacement: fileURLToPath(new URL('./src/test/use-sync-external-store.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    server: { deps: { inline: ['@tanstack/react-table', '@tanstack/react-store', /@base-ui\//] } },
  },
});
