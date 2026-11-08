import { defineConfig } from 'vitest/config';

// Pure export regressions only: no test-services.ts hooks, sockets, environment files or shared backing services.
export default defineConfig({
  test: {
    include: ['src/export-stream.test.ts', 'src/export-lifecycle.test.ts', 'src/export-outcomes.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
