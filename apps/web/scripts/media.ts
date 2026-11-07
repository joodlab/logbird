import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { clips, imageWidths, screenshots, type Variant } from '../src/lib/media-manifest';

const root = resolve('../..');
const output = resolve('public/media');
// Start empty: every file is regenerated below, and a capture removed from the manifest must not ship.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
async function source(path: string) {
  const file = resolve(root, path);
  const bytes = await readFile(file).catch(() => {
    throw new Error(`Missing media source: ${path}. Restore the capture before building.`);
  });
  if (bytes.subarray(0, 100).toString().startsWith('version https://git-lfs.github.com/spec/v1')) {
    throw new Error(`Git LFS pointer: ${path}. Run git lfs pull, then retry pnpm media.`);
  }
  return { file, bytes };
}
// Sequential encoding keeps the build's memory use bounded.
sharp.concurrency(1);
async function encode(id: string, variant: Variant, widths: number[]) {
  for (const theme of ['light', 'dark'] as const) {
    const path = variant[theme];
    if (!path) {
      continue;
    }
    const { bytes } = await source(path);
    const metadata = await sharp(bytes).metadata();
    if (metadata.width !== variant.width || metadata.height !== variant.height) {
      throw new Error(`Media dimensions changed: ${id}/${theme}. Update the manifest after inspection.`);
    }
    for (const width of widths) {
      for (const format of ['avif', 'webp'] as const) {
        await sharp(bytes)
          .resize({ width, withoutEnlargement: true })
          [format]({ quality: format === 'avif' ? 55 : 82 })
          .toFile(resolve(output, `${id}-${theme}-${width}.${format}`));
      }
    }
  }
}
for (const entry of screenshots) {
  await encode(entry.id, entry, imageWidths(entry.width));
  if (entry.phone) {
    // Phone captures are served at their native width (390 CSS px).
    await encode(`${entry.id}-phone`, entry.phone, [entry.phone.width]);
  }
}
for (const clip of clips) {
  const video = await source(clip.src);
  const poster = await source(clip.poster);
  await copyFile(video.file, resolve(output, `${clip.id}.webm`));
  await sharp(poster.bytes)
    .webp({ quality: 82 })
    .toFile(resolve(output, `${clip.id}-poster.webp`));
}
console.log(`Prepared ${screenshots.length} screenshots and ${clips.length} clips.`);
