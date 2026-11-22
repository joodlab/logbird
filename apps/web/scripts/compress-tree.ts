import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync, gzipSync } from 'node:zlib';
import { withEmailOff } from '../src/lib/email-off';

const extensions = ['.html', '.xml', '.txt', '.webmanifest', '.svg'];
/** Smaller files are served as they are; their variants are written only to replace stale ones. */
const MIN_BYTES = 1024;

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

/** Whether `path` exists, and if so whether it decodes to exactly `body`. */
async function variant(path: string, body: Buffer, decode: (data: Buffer) => Buffer): Promise<'missing' | 'current' | 'stale'> {
  const data = await readFile(path).catch(() => undefined);
  if (!data) {
    return 'missing';
  }
  try {
    return decode(data).equals(body) ? 'current' : 'stale';
  } catch {
    return 'stale';
  }
}

/**
 * Wraps every HTML page in Cloudflare's `email_off` pair (src/lib/email-off.ts), then makes each text file's `.br` and
 * `.gz` siblings decode to the file's final bytes: a missing or stale sibling is (re)written, a current one is kept, so
 * a second run, or a run after a partial write, repairs what the first left behind. Returns how many files changed.
 */
export async function compressTree(root: string): Promise<{ marked: number; written: number }> {
  let marked = 0;
  let written = 0;
  for await (const file of walk(root)) {
    let body = await readFile(file);
    if (file.endsWith('.html')) {
      const html = body.toString('utf8');
      const wrapped = withEmailOff(html);
      if (wrapped !== html) {
        body = Buffer.from(wrapped, 'utf8');
        await writeFile(file, body);
        marked += 1;
      }
    }
    const br = await variant(`${file}.br`, body, (data) => brotliDecompressSync(data));
    const gz = await variant(`${file}.gz`, body, (data) => gunzipSync(data));
    const wanted = body.byteLength >= MIN_BYTES;
    if (br === 'stale' || (wanted && br === 'missing')) {
      await writeFile(`${file}.br`, brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
      written += 1;
    }
    if (gz === 'stale' || (wanted && gz === 'missing')) {
      await writeFile(`${file}.gz`, gzipSync(body, { level: 9 }));
      written += 1;
    }
  }
  return { marked, written };
}
