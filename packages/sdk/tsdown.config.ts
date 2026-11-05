import { defineConfig } from 'tsdown';
export default defineConfig({ entry: ['src/index.ts', 'src/read.ts', 'src/integration.ts'], format: 'esm', dts: true });
