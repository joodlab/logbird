import { defineConfig } from 'vitest/config';

/** Unit tests only need path aliases, not the Start/Nitro plugins in vite.config.ts. */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: { include: ['src/**/*.test.ts'] },
});
