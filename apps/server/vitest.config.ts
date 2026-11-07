import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { setupFiles: ['./src/test-services.ts'], fileParallelism: false, maxWorkers: 1, testTimeout: 360_000, hookTimeout: 360_000 },
});
