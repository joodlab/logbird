#!/usr/bin/env node
// Checks packed npm tarballs before they are published or attached to a release.
//
//   node scripts/check-npm-packages.mjs <folder with the .tgz files> [expected version]
//
// For each tarball it requires:
// - a known package (PACKAGES below), at the same version as the others (and the expected version, when given), with
//   no `workspace:` specifier left anywhere in its manifest;
// - `repository.directory` naming the package's folder, `license` MIT and a LICENSE file, `engines.node` set;
// - every `exports` target present in the tarball, and only `dist/` code shipped (no `src/`);
// - its runtime `dependencies` exactly the allowed ones, with every @logbird dependency at the same version;
// - every bare import in its built JavaScript and declarations (`dist/**/*.mjs`, `*.d.mts`, `*.d.ts`) declared as a
//   dependency or peer dependency, or a Node built-in, or listed for that package below. Never `zod` and never
//   `@logbird/contracts`: the SDK bundles what it needs from contracts, so the published packages do not depend on it;
// - no source map that records an absolute path (a machine's own path, as a local build would leave).
// The tarballs are read here (gzip, then the tar headers), with no dependency.
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** Every package that may be packed, with what it may import beyond its declared dependencies and peers. */
const PACKAGES = {
  '@logbird/sdk': { dir: 'packages/sdk', dependencies: [], alsoImports: [] },
  '@logbird/hono': { dir: 'packages/integrations/hono', dependencies: ['@logbird/sdk'], alsoImports: [] },
  '@logbird/vue': { dir: 'packages/integrations/vue', dependencies: ['@logbird/sdk'], alsoImports: [] },
  '@logbird/tanstack-start': { dir: 'packages/integrations/tanstack-start', dependencies: ['@logbird/sdk'], alsoImports: [] },
  // A Nuxt module runs inside the application's Nuxt: it imports Nuxt's own packages and virtual modules.
  '@logbird/nuxt': {
    dir: 'packages/integrations/nuxt',
    dependencies: ['@logbird/sdk', '@logbird/vue', '@nuxt/kit', 'h3'],
    alsoImports: ['#imports', '#logbird-hooks', '@nuxt/schema', 'nitropack', 'vue'],
  },
};
const FORBIDDEN = ['zod', '@logbird/contracts'];

/** The files of a .tgz: { path (without the leading "package/") → Buffer }. */
function readTarball(file) {
  const tar = gunzipSync(readFileSync(file));
  const files = new Map();
  let offset = 0;
  let longName;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = undefined;
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === '0' || type === '') {
      name = name.replace(/^package\//, '');
      if (files.has(name)) throw new Error(`${file}: two entries named ${name}`);
      files.set(name, body);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** The package a bare specifier names: "@scope/name/sub" → "@scope/name", "name/sub" → "name". */
const packageOf = (specifier) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** Bare specifiers imported by JavaScript or declaration text: static and dynamic imports, re-exports, require. */
function importsOf(text) {
  const found = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.add(match[1]);
  return [...found].filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('/'));
}

const [folder, expected] = process.argv.slice(2);
if (!folder) {
  console.error('usage: node scripts/check-npm-packages.mjs <folder with the .tgz files> [expected version]');
  process.exit(2);
}
const tarballs = readdirSync(folder).filter((file) => file.endsWith('.tgz'));
if (tarballs.length === 0) throw new Error(`no .tgz in ${folder}`);
const problems = [];
const versions = new Map();
for (const tarball of tarballs) {
  const fail = (message) => problems.push(`${tarball}: ${message}`);
  let files;
  try {
    files = readTarball(join(folder, tarball));
  } catch (error) {
    fail(`cannot be read as a tarball: ${error.message}`);
    continue;
  }
  const manifestBytes = files.get('package.json');
  if (!manifestBytes) {
    fail('no package.json');
    continue;
  }
  const manifestText = manifestBytes.toString('utf8');
  const manifest = JSON.parse(manifestText);
  const known = PACKAGES[manifest.name];
  if (!known) {
    fail(`${manifest.name} is not a package this repository publishes`);
    continue;
  }
  versions.set(manifest.name, manifest.version);
  if (expected && manifest.version !== expected) fail(`version ${manifest.version}, expected ${expected}`);
  if (manifestText.includes('workspace:')) fail('a workspace: specifier is left in package.json');
  if (manifest.repository?.directory !== known.dir) fail(`repository.directory is ${manifest.repository?.directory}, expected ${known.dir}`);
  if (manifest.license !== 'MIT' || !files.has('LICENSE')) fail('license must be MIT with a LICENSE file');
  if (!manifest.engines?.node) fail('engines.node is not set');
  if ([...files.keys()].some((path) => path.startsWith('src/'))) fail('ships src/');

  // Every exports target exists.
  const targets = [];
  const collect = (value) => {
    if (typeof value === 'string') targets.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(manifest.exports);
  if (targets.length === 0) fail('no exports');
  for (const target of targets) if (!files.has(target.replace(/^\.\//, ''))) fail(`exports names ${target}, which the tarball does not carry`);

  // Runtime dependencies: exactly the allowed ones; @logbird ones at this version.
  const dependencies = Object.keys(manifest.dependencies ?? {}).sort();
  if (JSON.stringify(dependencies) !== JSON.stringify([...known.dependencies].sort())) {
    fail(`dependencies are [${dependencies}], expected [${[...known.dependencies].sort()}]`);
  }
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (name.startsWith('@logbird/') && range !== manifest.version) fail(`depends on ${name}@${range}, not exactly ${manifest.version}`);
  }

  // Imports in the shipped code and declarations.
  const allowed = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}), ...known.alsoImports]);
  for (const [path, body] of files) {
    if (/\.(m?js|d\.m?ts)$/.test(path)) {
      for (const specifier of importsOf(body.toString('utf8'))) {
        const name = specifier.startsWith('#') ? specifier : packageOf(specifier);
        if (FORBIDDEN.includes(name)) fail(`${path} imports ${specifier}: the published packages must not depend on ${name}`);
        else if (!builtins.has(specifier) && !allowed.has(name)) fail(`${path} imports ${specifier}, which ${manifest.name} does not declare`);
      }
    }
    if (path.endsWith('.map')) {
      const map = JSON.parse(body.toString('utf8'));
      const absolute = (map.sources ?? []).filter((source) => /^([A-Za-z]:[\\/]|\/|file:)/.test(source));
      if (absolute.length) fail(`${path} records absolute paths: ${absolute.join(', ')}`);
    }
  }
}
if (new Set(versions.values()).size > 1) problems.push(`versions differ: ${[...versions].map(([name, version]) => `${name}@${version}`).join(', ')}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`npm packages OK: ${[...versions].map(([name, version]) => `${name}@${version}`).join(', ')}`);
