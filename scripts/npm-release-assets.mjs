#!/usr/bin/env node
// The npm tarballs a release attaches to its GitHub Release, built and checked in one place. Both workflows run this
// file: `.github/workflows/npm-tarballs.yml` (on pull requests, on master, and from the tag release) packs and checks
// the tarballs, and the release job verifies the same files again right before it attaches them.
//
//   node scripts/npm-release-assets.mjs pack <folder> [version]
//     Builds and packs the five packages into <folder> (which must be empty or absent), checks the tarballs with
//     scripts/check-npm-packages.mjs at [version] (default: the root package.json version), then writes SHA256SUMS.
//   node scripts/npm-release-assets.mjs verify <folder> <version>
//     Requires <folder> to hold exactly the release's asset set (one tarball per package at <version>, and SHA256SUMS
//     listing exactly those tarballs with matching checksums), then prints each asset's path, one per line, in the
//     order to attach them. Nothing else is printed to stdout; the table goes to stderr and to the GitHub step summary.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The packages a release packs, in attach order. The tarball name is what `pnpm pack` writes for name@version. */
export const PACKAGES = [
  { name: '@logbird/sdk', dir: 'packages/sdk' },
  { name: '@logbird/hono', dir: 'packages/integrations/hono' },
  { name: '@logbird/vue', dir: 'packages/integrations/vue' },
  { name: '@logbird/nuxt', dir: 'packages/integrations/nuxt' },
  { name: '@logbird/tanstack-start', dir: 'packages/integrations/tanstack-start' },
];
export const SUMS = 'SHA256SUMS';
export const tarballName = (name, version) => `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** SHA256SUMS in the format `sha256sum --check` reads: `<hex>  <file>` (two spaces: binary-safe text mode), LF. */
export function writeSums(folder, files) {
  const text = files.map((file) => `${sha256(join(folder, file))}  ${file}\n`).join('');
  writeFileSync(join(folder, SUMS), text);
  return text;
}

/** Parses SHA256SUMS strictly: one `<64 hex>  <file name>` per line, no paths, no duplicates. */
export function parseSums(text) {
  const entries = new Map();
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line);
    if (!match) throw new Error(`${SUMS} has a malformed line: ${JSON.stringify(line)}`);
    if (entries.has(match[2])) throw new Error(`${SUMS} lists ${match[2]} twice`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

/**
 * Checks that `folder` holds exactly the asset set of `version` and returns the assets ({ file, path, bytes, sha256 })
 * in attach order: the tarballs, then SHA256SUMS. Throws on a missing, extra or altered file.
 */
export function verifyAssets(folder, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error(`expected a release version X.Y.Z, got ${JSON.stringify(version)}`);
  const expected = PACKAGES.map(({ name }) => tarballName(name, version));
  const present = readdirSync(folder).sort();
  const wanted = [...expected, SUMS];
  const missing = wanted.filter((file) => !present.includes(file));
  const extra = present.filter((file) => !wanted.includes(file));
  if (missing.length || extra.length) {
    throw new Error(
      `${folder} does not hold the release asset set for ${version}.${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}${
        extra.length ? ` Unexpected: ${extra.join(', ')}.` : ''
      }`,
    );
  }
  const sums = parseSums(readFileSync(join(folder, SUMS), 'utf8'));
  const listed = [...sums.keys()].sort();
  if (listed.join('\n') !== [...expected].sort().join('\n')) {
    throw new Error(`${SUMS} must list exactly ${expected.join(', ')}; it lists ${listed.join(', ') || 'nothing'}`);
  }
  const assets = [];
  for (const file of wanted) {
    const path = join(folder, file);
    if (!statSync(path).isFile()) throw new Error(`${file} is not a regular file`);
    const digest = sha256(path);
    if (file !== SUMS && sums.get(file) !== digest) throw new Error(`${file} does not match its ${SUMS} entry`);
    assets.push({ file, path, bytes: statSync(path).size, sha256: digest });
  }
  return assets;
}

export function assetTable(assets) {
  return ['| Asset | Bytes | SHA-256 |', '| --- | ---: | --- |', ...assets.map((a) => `| \`${a.file}\` | ${a.bytes} | \`${a.sha256}\` |`)].join('\n');
}

function summary(markdown) {
  console.error(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n\n`);
}

function pack(folderArg, versionArg) {
  const folder = resolve(folderArg);
  const version = versionArg || JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  if (existsSync(folder) && readdirSync(folder).length) throw new Error(`${folder} must be empty: only this run's tarballs may be attached`);
  mkdirSync(folder, { recursive: true });
  // pnpm is a .cmd shim on Windows and needs a shell; no argument here holds a space-sensitive or shell character
  // except the folder, which is quoted.
  const shell = process.platform === 'win32';
  const quoted = shell ? `"${folder}"` : folder;
  for (const { dir } of PACKAGES) {
    const cwd = join(repo, dir);
    console.error(`$ (${dir}) pnpm build && pnpm pack --pack-destination ${folder}`);
    execFileSync('pnpm', ['build'], { cwd, stdio: ['ignore', 2, 2], shell });
    // pnpm pack applies publishConfig and replaces workspace: specifiers, as a publish does.
    execFileSync('pnpm', ['pack', '--pack-destination', quoted], { cwd, stdio: ['ignore', 2, 2], shell });
  }
  console.error(`$ node scripts/check-npm-packages.mjs ${folder} ${version}`);
  execFileSync(process.execPath, [join(repo, 'scripts', 'check-npm-packages.mjs'), folder, version], { stdio: ['ignore', 2, 2] });
  writeSums(
    folder,
    PACKAGES.map(({ name }) => tarballName(name, version)),
  );
  const assets = verifyAssets(folder, version);
  summary(`### npm tarballs for ${version}\n\nPacked and checked by \`scripts/check-npm-packages.mjs\`.\n\n${assetTable(assets)}`);
}

function verify(folderArg, version) {
  const assets = verifyAssets(resolve(folderArg), version);
  summary(`### Release assets for ${version} (verified)\n\n${assetTable(assets)}`);
  for (const { path } of assets) console.log(path);
}

function main(command, ...rest) {
  if (command === 'pack' && rest[0]) return pack(rest[0], rest[1]);
  if (command === 'verify' && rest[0] && rest[1]) return verify(rest[0], rest[1]);
  console.error('usage: node scripts/npm-release-assets.mjs pack <folder> [version] | verify <folder> <version>');
  process.exit(2);
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(...process.argv.slice(2));
  } catch (error) {
    console.error(`npm release assets: ${error.message}`);
    process.exit(1);
  }
}
