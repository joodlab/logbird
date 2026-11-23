import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';
import { expect, it } from 'vitest';

// The read helpers bundle the shared query parser from @logbird/contracts (#311). The published bundle must stay
// self-contained and free of zod, which the rest of contracts depends on: build it the way the package does and look.
it('bundles the read helpers self-contained and without zod', async () => {
  const cwd = join(dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = mkdtempSync(join(tmpdir(), 'logbird-sdk-bundle-'));
  try {
    await build({ config: false, cwd, entry: ['src/read.ts'], format: 'esm', dts: false, outDir, logLevel: 'silent' });
    const files = readdirSync(outDir).filter((file) => file.endsWith('.mjs'));
    expect(files).toContain('read.mjs');
    const code = files.map((file) => readFileSync(join(outDir, file), 'utf8')).join('\n');
    // It really holds the parser and the trail builder, and imports nothing.
    expect(code).toContain('an empty trail would be the whole project');
    expect(code).toContain('is not a complete Logbird query on its own');
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\brequire\(/);
    expect(code).not.toMatch(/\bzod\b/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 60_000);
