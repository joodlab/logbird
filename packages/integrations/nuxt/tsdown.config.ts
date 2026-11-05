import { defineConfig } from 'tsdown';
export default defineConfig({
  entry: ['src/index.ts', 'src/runtime/plugin.ts', 'src/runtime/events.ts', 'src/runtime/composable.ts', 'src/runtime/deny.ts'],
  format: 'esm',
  dts: false,
  external: [/^[^./]/],
});
