import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true, dedupe: ['react', 'react-dom'] },
  test: {
    include: ['src/**/*.test.ts'],
    // Tests run against a fictional released configuration; release.test.ts checks the blocked states explicitly.
    env: { WEB_SITE_URL: 'https://site.example.test', WEB_SECURITY_EMAIL: 'security@example.test', WEB_CONTACT_EMAIL: 'hello@example.test' },
  },
});
