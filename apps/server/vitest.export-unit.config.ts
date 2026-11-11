import { defineConfig } from 'vitest/config';

// Pure regressions only (exports, failure HTTP mapping, source boundaries): no test-services.ts hooks, sockets, environment files
// or shared backing services.
export default defineConfig({
  test: {
    include: [
      'src/export-stream.test.ts',
      'src/export-lifecycle.test.ts',
      'src/export-outcomes.test.ts',
      'src/delete-errors.test.ts',
      'src/ingest-receipt-errors.test.ts',
      'src/receipt-maintenance-boundary.test.ts',
      'src/immutable-ingest-receipt-errors.test.ts',
      '../worker/src/failed-repair-status.test.ts',
      '../worker/src/retention-sweep.test.ts',
      '../worker/src/receipt-index-compaction.test.ts',
      '../worker/src/receipt-index-scheduler.test.ts',
    ],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
