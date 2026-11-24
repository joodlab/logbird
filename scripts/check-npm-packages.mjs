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
// - its `dependencies` and `peerDependencies` exactly the allowed ones, every @logbird dependency at the same version,
//   no optional or bundled dependencies, and `zod` / `@logbird/contracts` in none of those fields;
// - every bare import in its built JavaScript and declarations (`dist/**/*.mjs`, `*.d.mts`, `*.d.ts`), compact or
//   spaced, static, side-effect, dynamic or `require`, declared as a dependency or peer dependency, or a Node built-in,
//   or listed for that package below. Never `zod` and never `@logbird/contracts`: the SDK bundles what it needs from
//   contracts, so the published packages do not depend on it;
// - no source map whose `sources` or `sourceRoot` is an absolute path (POSIX, drive, UNC or file: URL), as a local
//   build would leave.
// The tarballs are read here (gzip, then the tar headers), with no dependency.
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** Every package that may be packed, with what it may import beyond its declared dependencies and peers. */
const PACKAGES = {
  '@logbird/sdk': { dir: 'packages/sdk', dependencies: [], peers: [], alsoImports: [] },
  '@logbird/hono': { dir: 'packages/integrations/hono', dependencies: ['@logbird/sdk'], peers: ['hono'], alsoImports: [] },
  '@logbird/vue': { dir: 'packages/integrations/vue', dependencies: ['@logbird/sdk'], peers: ['vue'], alsoImports: [] },
  '@logbird/tanstack-start': {
    dir: 'packages/integrations/tanstack-start',
    dependencies: ['@logbird/sdk'],
    peers: ['@tanstack/react-start'],
    alsoImports: [],
  },
  // A Nuxt module runs inside the application's Nuxt: it imports Nuxt's own packages and virtual modules.
  '@logbird/nuxt': {
    dir: 'packages/integrations/nuxt',
    dependencies: ['@logbird/sdk', '@logbird/vue', '@nuxt/kit', 'h3'],
    peers: ['nuxt'],
    alsoImports: ['#imports', '#logbird-hooks', '@nuxt/schema', 'nitropack', 'vue'],
  },
};
const FORBIDDEN = ['zod', '@logbird/contracts'];
/** Manifest fields that make npm install something for the consumer, or name what may be bundled with it. */
const INSTALLED_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies'];
/** An absolute path: POSIX, a drive (either slash), a UNC or other backslash-rooted path, or a file: URL. */
const ABSOLUTE = /^([A-Za-z]:[\\/]|[\\/]|file:)/;

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

/**
 * Bare specifiers imported by JavaScript or declaration text. Deliberately broad, so compact or minified code cannot
 * slip past: any `from "x"` (static imports and re-exports, with or without spaces: `import{z}from"zod"`,
 * `export*from"x"`), a side-effect `import "x"`, `import("x")` (dynamic, or a declaration's type import) and
 * `require("x")`. Text inside a string is not read as an import (`"Migrated from 'zod'"`). A commented-out import
 * (`// import … from 'zod'`) is reported, deliberately: stripping comments with a regex would also strip `//` inside a
 * string such as a URL and could hide a real import after it on the same line, so the scan fails safe instead.
 */
function importsOf(text) {
  const found = new Set();
  // A module specifier has no whitespace; prose in a message string ("from 'a' and/or 'b'") does, so it is skipped.
  const specifier = String.raw`["']([@#\w][^"'\s]*)["']`;
  // Between tokens: whitespace and block or line comments (`import/* generated */"zod"`).
  const gap = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;
  const patterns = [
    // `from` only as part of an import or export statement: from the keyword to `from`, no quote or semicolon, so a
    // string such as "Migrated from 'zod'" is not read as one. Compact (`import{z}from"zod"`, `export*from"x"`),
    // multi-line and `import type` forms still match.
    new RegExp(String.raw`\b(?:import|export)\b[^;'"\x60]*?\bfrom${gap}${specifier}`, 'g'),
    new RegExp(String.raw`\bimport${gap}${specifier}`, 'g'),
    // No closing parenthesis required: `import('x', { with: … })` has a second argument.
    new RegExp(String.raw`\bimport${gap}\(${gap}${specifier}`, 'g'),
    new RegExp(String.raw`\brequire${gap}\(${gap}${specifier}`, 'g'),
    // A template literal without substitutions is a static specifier too: import(`zod`). Only inside these calls, so a
    // template string of prose elsewhere is not read as one.
    new RegExp(String.raw`\b(?:import|require)${gap}\(${gap}\x60([@#\w][^\x60\s$]*)\x60`, 'g'),
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.add(match[1]);
  return [...found];
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

  // What npm installs for a consumer: exactly the allowed dependencies and peers, no optional or bundled ones, and
  // never zod or @logbird/contracts in any of these fields.
  for (const field of INSTALLED_FIELDS) {
    const names = Array.isArray(manifest[field]) ? manifest[field] : Object.keys(manifest[field] ?? {});
    for (const name of names) if (FORBIDDEN.includes(name)) fail(`${field} names ${name}: the published packages must not depend on it`);
  }
  const same = (actual, wanted) => JSON.stringify([...actual].sort()) === JSON.stringify([...wanted].sort());
  const dependencies = Object.keys(manifest.dependencies ?? {});
  if (!same(dependencies, known.dependencies)) fail(`dependencies are [${dependencies.sort()}], expected [${[...known.dependencies].sort()}]`);
  const peers = Object.keys(manifest.peerDependencies ?? {});
  if (!same(peers, known.peers)) fail(`peerDependencies are [${peers.sort()}], expected [${[...known.peers].sort()}]`);
  for (const field of ['optionalDependencies', 'bundleDependencies', 'bundledDependencies']) {
    const value = manifest[field];
    // `true` bundles every dependency (npm accepts both spellings); false, absent and an empty list or object are fine.
    const nonEmpty =
      value === true || (Array.isArray(value) ? value.length > 0 : value && typeof value === 'object' && Object.keys(value).length > 0);
    if (nonEmpty) fail(`${field} must be empty`);
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
      // A relative source resolves beneath sourceRoot, so an absolute sourceRoot records a machine's path too.
      const absolute = [map.sourceRoot, ...(map.sources ?? [])].filter((source) => typeof source === 'string' && ABSOLUTE.test(source));
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
