import { defineConfig } from 'tsdown';
// TanStack Start and React are the application's: reference them, never copy their code or types into ours.
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  external: [/^@logbird\//, /^@tanstack\//, /^react(\/|$)/, /^react-dom(\/|$)/],
});
