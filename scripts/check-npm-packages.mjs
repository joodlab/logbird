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
// - every bare import in its built JavaScript and declarations (`dist/**/*.mjs`, `*.d.mts`, `*.d.ts`), read from the
//   parsed file (static, type, side-effect, dynamic, `require`, re-export), declared as a dependency or peer dependency,
//   or a Node built-in, or listed for that package below. Never `zod` and never `@logbird/contracts`: the SDK bundles
//   what it needs from contracts, so the published packages do not depend on it;
// - no source map whose `sources` or `sourceRoot` is an absolute path (POSIX, drive, UNC or file: URL), as a local
//   build would leave.
// The tarballs are read here (gzip, then the tar headers); the code is parsed with @babel/parser.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { parse } from '@babel/parser';

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

/** Keys of a Babel node that hold positions or comments, not child nodes. */
const NOT_CHILDREN = new Set(['loc', 'start', 'end', 'range', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments']);

/**
 * The module specifier a node holds ('' when it is not known without running the code): a string, or a template with
 * no substitution (`zod`). For a template with substitutions (`zod/${name}`), the package its fixed head already names.
 */
function specifierOf(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TSLiteralType') return specifierOf(node.literal);
  if (node?.type !== 'TemplateLiteral') return '';
  const head = node.quasis[0]?.value.cooked ?? '';
  if (node.expressions.length === 0) return head;
  return head.split('/').length > (head.startsWith('@') ? 2 : 1) ? packageOf(head) : '';
}

/**
 * Every module specifier a shipped file imports, read from its syntax tree (Babel, with TypeScript syntax for
 * declarations), so the spelling cannot matter (`import{z}from"zod"`, comments between tokens, line breaks) and text in
 * a string or a comment is never read as an import. Covered: static imports and type imports, re-exports
 * (`export … from`, `export * from`), side-effect imports, dynamic `import()` (with or without a second argument), a
 * declaration's `import("x").T`, `require()` (also optional, `module.require()`, and a function made by
 * `createRequire`), `import x = require()` and a `/// <reference types="x" />` directive where TypeScript reads one.
 * A file is parsed as Node would load it: `.mjs` as a module, `.cjs` as a script, `.js` by the `type` of its package
 * (`moduleType`). A file that does not parse fails the check rather than being skipped.
 */
export function importsOf(text, path, moduleType = 'commonjs') {
  const declaration = /\.d\.[cm]?ts$/.test(path);
  const asModule = declaration || path.endsWith('.mjs') || (path.endsWith('.js') && moduleType === 'module');
  const ast = parse(text, {
    sourceType: asModule ? 'module' : 'script',
    allowReturnOutsideFunction: !asModule,
    plugins: declaration ? [['typescript', { dts: true }]] : [],
  });
  const found = new Set();
  const add = (node) => {
    const specifier = specifierOf(node);
    if (specifier) found.add(specifier);
  };
  // The names `createRequire` is bound to: itself, `import { createRequire as cr }`, `const { createRequire: cr } = …`.
  const makers = new Set(['createRequire']);
  const keyName = (node) => (node?.type === 'Identifier' ? node.name : node?.type === 'StringLiteral' ? node.value : undefined);
  // `createRequire(…)`, `cr(…)` or `module.createRequire(…)`: its result is a require function.
  const makesRequire = (node) =>
    (node?.type === 'CallExpression' || node?.type === 'OptionalCallExpression') &&
    (node.callee.type === 'Identifier' ? makers.has(node.callee.name) : keyName(node.callee.property) === 'createRequire');
  // The names a require function is bound to: `require`, and every `const r = createRequire(…)` or `r = createRequire(…)`.
  const requires = new Set(['require']);
  const walk = (node, step) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, step);
      return;
    }
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    step(node);
    for (const [key, child] of Object.entries(node)) if (!NOT_CHILDREN.has(key)) walk(child, step);
  };
  walk(ast.program, (node) => {
    if (node.type === 'ImportSpecifier' && keyName(node.imported) === 'createRequire') makers.add(node.local.name);
    if (node.type === 'ObjectPattern') {
      for (const property of node.properties) {
        if (property.type === 'ObjectProperty' && keyName(property.key) === 'createRequire' && property.value.type === 'Identifier')
          makers.add(property.value.name);
      }
    }
  });
  walk(ast.program, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && makesRequire(node.init)) requires.add(node.id.name);
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && makesRequire(node.right)) requires.add(node.left.name);
  });
  const loads = (callee) =>
    callee.type === 'Import' ||
    (callee.type === 'Identifier' && requires.has(callee.name)) ||
    // `module.require('x')`, `globalThis.require?.('x')`
    ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && !callee.computed && callee.property.name === 'require') ||
    // `createRequire(import.meta.url)('x')`
    makesRequire(callee);
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
      case 'ImportExpression':
        add(node.source);
        break;
      case 'CallExpression':
      case 'OptionalCallExpression':
        if (loads(node.callee)) add(node.arguments[0]);
        break;
      case 'TSImportType':
        add(node.argument);
        break;
      case 'TSExternalModuleReference':
        add(node.expression);
        break;
      default:
    }
    for (const [key, child] of Object.entries(node)) if (!NOT_CHILDREN.has(key)) visit(child);
  };
  visit(ast.program);
  // TypeScript reads a `/// <reference types>` directive only before the first statement, with its attributes in any
  // order (`/// <reference preserve="true" types="x" />`).
  const firstCode = Math.min(ast.program.body[0]?.start ?? Number.POSITIVE_INFINITY, ast.program.directives?.[0]?.start ?? Number.POSITIVE_INFINITY);
  for (const comment of ast.comments ?? []) {
    if (comment.type !== 'CommentLine' || comment.start > firstCode) continue;
    const reference = /^\/\s*<reference\b[^>]*?\stypes\s*=\s*(["'])(.+?)\1/.exec(comment.value);
    if (reference) found.add(reference[2]);
  }
  // Relative and absolute paths are the package's own files.
  return [...found].filter((specifier) => !/^[./]/.test(specifier));
}

/** Checks every tarball in a folder; prints what is wrong and exits 1, or prints the packages that passed. */
function main(folder, expected) {
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

    // Imports in the shipped code and declarations. A `.js` file is a module or a script by the `type` of the nearest
    // package.json above it in the tarball, as Node decides.
    const moduleTypeOf = (path) => {
      for (let dir = path; dir.includes('/'); ) {
        dir = dir.slice(0, dir.lastIndexOf('/'));
        const nested = files.get(`${dir}/package.json`);
        if (nested) return JSON.parse(nested.toString('utf8')).type ?? 'commonjs';
      }
      return manifest.type ?? 'commonjs';
    };
    const allowed = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}), ...known.alsoImports]);
    for (const [path, body] of files) {
      if (/\.([cm]?js|d\.[cm]?ts)$/.test(path)) {
        let specifiers;
        try {
          specifiers = importsOf(body.toString('utf8'), path, moduleTypeOf(path));
        } catch (error) {
          fail(`${path} cannot be parsed, so its imports cannot be checked: ${error.message}`);
          continue;
        }
        for (const specifier of specifiers) {
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
  if (new Set(versions.values()).size > 1)
    problems.push(`versions differ: ${[...versions].map(([name, version]) => `${name}@${version}`).join(', ')}`);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`npm packages OK: ${[...versions].map(([name, version]) => `${name}@${version}`).join(', ')}`);
}

// Run as a script; imported (by its test), only the import scan is used.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) main(...process.argv.slice(2));
