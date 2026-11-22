import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compressTree } from '../../scripts/compress-tree';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'logbird-compress-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const page = `<!doctype html><html><body>${'<p>Fictional page body.</p>'.repeat(80)}</body></html>`;
const decoded = async (file: string) => ({
  br: brotliDecompressSync(await readFile(`${file}.br`)).toString('utf8'),
  gz: gunzipSync(await readFile(`${file}.gz`)).toString('utf8'),
});

describe('compressTree', () => {
  it('replaces variants that predate the email_off wrap, so every encoding serves the final page', async () => {
    const file = join(root, 'index.html');
    // What Nitro leaves behind: the page and both variants of its unwrapped bytes.
    await writeFile(file, page);
    await writeFile(`${file}.br`, brotliCompressSync(page));
    await writeFile(`${file}.gz`, gzipSync(page));

    expect(await compressTree(root)).toEqual({ marked: 1, written: 2 });
    const final = await readFile(file, 'utf8');
    expect(final).toContain('<!--email_off-->');
    expect(await decoded(file)).toEqual({ br: final, gz: final });
  });

  it('repairs a missing sibling on a second run and leaves current ones alone', async () => {
    const file = join(root, 'about', 'index.html');
    await mkdir(join(root, 'about'));
    await writeFile(file, page);
    await compressTree(root);
    const brBefore = (await stat(`${file}.br`)).mtimeMs;
    await rm(`${file}.gz`);

    expect(await compressTree(root)).toEqual({ marked: 0, written: 1 });
    const final = await readFile(file, 'utf8');
    expect(await decoded(file)).toEqual({ br: final, gz: final });
    expect((await stat(`${file}.br`)).mtimeMs).toBe(brBefore);
  });

  it('rewrites a corrupt variant and skips small files that have none', async () => {
    const file = join(root, 'sitemap.xml');
    const xml = `<urlset>${'<url><loc>https://site.example.test/</loc></url>'.repeat(40)}</urlset>`;
    await writeFile(file, xml);
    await writeFile(`${file}.br`, 'not brotli');
    await writeFile(join(root, 'robots.txt'), 'User-agent: *\n');

    expect(await compressTree(root)).toEqual({ marked: 0, written: 2 });
    expect(await decoded(file)).toEqual({ br: xml, gz: xml });
    expect(await stat(join(root, 'robots.txt.br')).catch(() => null)).toBeNull();
  });
});
