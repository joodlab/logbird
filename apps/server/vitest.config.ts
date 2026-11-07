import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    setupFiles: ['./src/test-services.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 360_000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'], exclude: ['src/**/*.integration.test.ts'], testTimeout: 10_000 } },
      { extends: true, test: { name: 'integration', include: ['src/**/*.integration.test.ts'], testTimeout: 360_000 } },
    ],
  },
});
