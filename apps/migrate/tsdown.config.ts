import { defineConfig, type UserConfig } from 'tsdown';

// The migration image ships these bundles instead of the workspace sources, tsx and full node_modules.
// `deps` fails the build if anything else gets inlined or left as a runtime import.
const shared: UserConfig = { format: 'esm', platform: 'node', target: 'node22', dts: false, sourcemap: false, clean: true };

export default defineConfig([
  {
    ...shared,
    // Image path: packages/clickhouse/dist/*.mjs. migrate() reads ../migrations/ relative to the bundle.
    entry: {
      migrate: '../../packages/clickhouse/scripts/migrate.ts',
      'create-query-user': '../../packages/clickhouse/scripts/create-query-user.ts',
    },
    outDir: 'dist/clickhouse',
    deps: { onlyBundle: [/^@clickhouse\//], onlyImport: [] },
  },
  {
    ...shared,
    // Image path: packages/database/prisma.config.mjs, next to prisma/schema.prisma and prisma/migrations.
    // `prisma/config` stays external: the Prisma CLI in the image provides it.
    entry: { 'prisma.config': '../../packages/database/prisma.config.ts' },
    outDir: 'dist/database',
    deps: { onlyBundle: ['@t3-oss/env-core', 'zod'], onlyImport: ['prisma'] },
  },
]);
