#!/usr/bin/env node
// Copies exactly the files that built Node entrypoints load at runtime into <out-dir>, keeping their
// workspace-relative paths (apps/<role>/dist/..., node_modules/...). Used by the server and worker
// Dockerfiles instead of `pnpm deploy`: the entrypoints already bundle the @logbird/* packages and most
// third-party code, so the deployed dependency tree was mostly unused files.
//
// Usage (from the workspace root): node scripts/trace-runtime.mjs <out-dir> <entry> [entry...]
import { copyFile, lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { nodeFileTrace } from '@vercel/nft';

const [outDir, ...entries] = process.argv.slice(2);
if (!outDir || entries.length === 0) {
  console.error('Usage: node scripts/trace-runtime.mjs <out-dir> <entry> [entry...]');
  process.exit(2);
}

const base = process.cwd();
const { fileList, warnings } = await nodeFileTrace(
  entries.map((entry) => resolve(base, entry)),
  { base },
);

let files = 0;
let bytes = 0;
for (const file of [...fileList].sort()) {
  const source = join(base, file);
  const target = join(outDir, file);
  await mkdir(dirname(target), { recursive: true });
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) await symlink(await readlink(source), target);
  else if (stat.isFile()) {
    await copyFile(source, target);
    files += 1;
    bytes += stat.size;
  }
}

// Unresolved optional imports (for example pg-native or bullmq's Valkey GLIDE client) were absent from the
// previous deployed tree as well; list them so a reviewer can see what the trace could not include.
for (const warning of warnings) console.warn(`trace warning: ${warning.message.split('\n')[0]}`);
console.log(`Traced ${files} files (${bytes} bytes) for ${entries.join(', ')} into ${outDir}`);
