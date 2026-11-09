import { defineConfig } from 'vitest/config';

/**
 * Every public WEB_* key is pinned here, before any test file imports src/env.ts (its singleton reads process.env at
 * import), so no test depends on the machine's environment or a developer's .env. The values are a fictional released
 * configuration with a private repository and no publisher name; tests that cover the other state override keys
 * explicitly (vi.stubEnv + vi.resetModules), and release.test.ts checks the blocked states. env.test.ts keeps this list
 * complete.
 */
export const TEST_PUBLIC_ENV = {
  WEB_SITE_URL: 'https://site.example.test',
  WEB_APP_URL: '',
  WEB_GITHUB_URL: '',
  WEB_GITHUB_PUBLIC: 'false',
  WEB_ORG_NAME: '',
  WEB_SECURITY_EMAIL: 'security@example.test',
  WEB_CONTACT_EMAIL: 'hello@example.test',
};

export default defineConfig({
  // One React and one router for the site and @logbird/ui, so whole pages render in tests (source-state.test.ts).
  resolve: { tsconfigPaths: true, dedupe: ['react', 'react-dom', '@tanstack/react-router'] },
  test: {
    include: ['src/**/*.test.ts'],
    env: TEST_PUBLIC_ENV,
  },
});
