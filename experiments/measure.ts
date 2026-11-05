import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const measurements: { generator: string; platform: string; format: string; bytes: number; gzipBytes: number }[] = [];
for (const name of ['forge', 'hey-api']) {
  for (const platform of ['browser', 'node'] as const) {
    const result = await build({
      entryPoints: [`experiments/${name}/public/index.ts`],
      bundle: true,
      platform,
      format: 'esm',
      minify: true,
      write: false,
    });
    const bytes = result.outputFiles[0]?.contents;
    if (!bytes) throw new Error('Missing bundle');
    measurements.push({ generator: name, platform, format: 'esm', bytes: bytes.length, gzipBytes: gzipSync(bytes).length });
  }
}
await writeFile('experiments/bundle-results.json', `${JSON.stringify(measurements, null, 2)}\n`);
console.log(measurements);
