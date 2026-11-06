import { defineConfig } from 'tsdown';
export default defineConfig({
  entry: ['src/index.ts', 'src/health.ts'],
  format: ['esm'],
  noExternal: [/^@trailmark\//],
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: true,
  sourcemap: true,
});
