import { defineConfig } from 'vitest/config';

// Pure regressions only (exports, delete-failure HTTP mapping): no test-services.ts hooks, sockets, environment files
// or shared backing services.
export default defineConfig({
  test: {
    include: [
      'src/export-stream.test.ts',
      'src/export-lifecycle.test.ts',
      'src/export-outcomes.test.ts',
      'src/delete-errors.test.ts',
      'src/ingest-parse-isolation.test.ts',
      'src/immutable-ingest.test.ts',
    ],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
