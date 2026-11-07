/**
 * Prerendered pages are written after Nitro's `compressPublicAssets` step, so the Node preview would serve them
 * uncompressed. Write .br/.gz copies next to every prerendered text file. (Cloudflare compresses on its own.)
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = resolve(process.argv[2] ?? '.output/public');
const extensions = ['.html', '.xml', '.txt', '.webmanifest', '.svg'];

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      yield path;
    }
  }
}

let count = 0;
for await (const file of walk(root)) {
  const body = await readFile(file);
  if (body.byteLength < 1024 || (await stat(`${file}.br`).catch(() => null))) {
    continue;
  }
  await writeFile(`${file}.br`, brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
  await writeFile(`${file}.gz`, gzipSync(body, { level: 9 }));
  count += 1;
}
console.log(`compress-html: wrote .br/.gz for ${count} files in ${root}`);
