import { defineConfig } from 'tsdown';
export default defineConfig({ entry: ['src/rpc.ts'], format: ['esm'], platform: 'node', target: 'node22', dts: true, clean: false, sourcemap: true });
