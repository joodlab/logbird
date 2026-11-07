import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { prerenderPaths } from '../src/lib/site-map';

const root = '.output/public';
const manifest = JSON.parse(await readFile(`${root}/.vite/manifest.json`, 'utf8')) as Record<string, { file: string; imports?: string[] }>;
const byFile = new Map(Object.values(manifest).map((entry) => [entry.file, entry]));
const report: { path: string; gzipBytes: number; files: string[] }[] = [];
for (const path of [...prerenderPaths, '/404']) {
  const file = path === '/' ? '/index.html' : path === '/404' ? '/404.html' : `${path}/index.html`;
  const html = await readFile(`${root}${file}`, 'utf8');
  const files = new Set<string>();
  function visit(file: string) {
    if (files.has(file) || !file.endsWith('.js')) {
      return;
    }
    files.add(file);
    for (const key of byFile.get(file)?.imports ?? []) {
      const entry = manifest[key];
      if (entry) {
        visit(entry.file);
      }
    }
  }
  for (const match of html.matchAll(/(?:src|href)="\/(assets\/[^"?]+\.js)"/g)) {
    if (match[1]) {
      visit(match[1]);
    }
  }
  let gzipBytes = 0;
  for (const file of files) {
    gzipBytes += gzipSync(await readFile(`${root}/${file}`)).byteLength;
  }
  report.push({ path, gzipBytes, files: [...files] });
}
await mkdir('.tmp', { recursive: true });
await writeFile('.tmp/bundle-sizes.json', JSON.stringify(report, null, 2));
console.table(report.map(({ path, gzipBytes }) => ({ path, gzipKiB: (gzipBytes / 1024).toFixed(2) })));
