#!/usr/bin/env node
// Checks packed npm tarballs before they are published or attached to a release.
//
//   node scripts/check-npm-packages.mjs <folder with the .tgz files> [expected version]
//
// For each tarball it requires:
// - a known package (PACKAGES below), at the same version as the others (and the expected version, when given), with
//   no `workspace:` specifier left anywhere in its manifest;
// - `repository.directory` naming the package's folder, `license` MIT and a LICENSE file, `engines.node` set;
// - every `exports` target present in the tarball, and nothing shipped but `dist/` JavaScript, declarations and source
//   maps, `package.json`, the README, LICENSE and CHANGELOG (no source anywhere: `src/`, `lib/helper.ts`, `dist/x.ts`);
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
import babelTraverse from '@babel/traverse';

// @babel/traverse is CommonJS; its function is the default export's `default`.
const traverse = babelTraverse.default ?? babelTraverse;

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
/**
 * What a tarball may carry under dist/: JavaScript and declarations, each with an optional source map, and a nested
 * package.json, which a dual build uses to set a folder's module type (`dist/cjs/package.json`).
 */
const DIST_FILE = /^dist\/(?:.+\.(?:[cm]?js|d\.[cm]?ts)(?:\.map)?|(?:.+\/)?package\.json)$/;
/** What it may carry outside dist/: npm always includes package.json, the readme, the licence and the changelog. */
const TOP_LEVEL_FILE = /^(?:package\.json|(?:README|LICENSE|LICENCE|CHANGELOG)(?:\.md|\.txt)?)$/i;
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
 * A file is parsed as Node would load it: `.mjs` as a module, `.cjs` as CommonJS, `.js` by the `type` of its package
 * (`moduleType`). A file that does not parse fails the check rather than being skipped.
 */
export function importsOf(text, path, moduleType = 'commonjs') {
  const declaration = /\.d\.[cm]?ts$/.test(path);
  const asModule = declaration || path.endsWith('.mjs') || (path.endsWith('.js') && moduleType === 'module');
  // `commonjs` is Node's CommonJS wrapper: top-level `return` and `new.target` are allowed, as Node allows them.
  const ast = parse(text, { sourceType: asModule ? 'module' : 'commonjs', plugins: declaration ? [['typescript', { dts: true }]] : [] });
  // Every identifier's lexical binding, from Babel's scope analysis, so a parameter or local that shadows a require
  // function is a different binding (`function validate(load) { return load(x); }` beside a module-level `load`).
  const bindingOf = new Map();
  traverse(ast, {
    Identifier(path) {
      bindingOf.set(path.node, path.scope.getBinding(path.node.name) ?? null);
    },
  });
  // A top-level `var x;` that is never given a value redeclares a name without replacing it: in CommonJS, `var require;`
  // still holds the wrapper's `require`. Such a binding is read as the name itself.
  // Only CommonJS has that wrapper; in a module a bare `var require;` is just undefined. Repeating the bare declaration
  // (`var require; var require;`) still replaces nothing.
  // A loop head is not bare: `for (var require of list)` gives it each item.
  const bareVar = (path) =>
    path.isVariableDeclarator() &&
    path.node.init == null &&
    !(path.parentPath?.key === 'left' && (path.parentPath.parentPath?.isForInStatement() || path.parentPath.parentPath?.isForOfStatement()));
  // Only the names the CommonJS wrapper supplies; `var globalThis;` declares a new, undefined variable.
  const WRAPPER_NAMES = new Set(['require', 'module', 'exports', '__filename', '__dirname']);
  const keepsOuter = (binding) =>
    !asModule &&
    WRAPPER_NAMES.has(binding.identifier.name) &&
    binding.kind === 'var' &&
    binding.scope.path.isProgram() &&
    bareVar(binding.path) &&
    binding.constantViolations.every(bareVar);
  /** What an identifier refers to: its binding, or `global:<name>` for a name the file does not declare. */
  const keyOf = (node) => {
    if (node?.type !== 'Identifier') return;
    const binding = bindingOf.get(node);
    return binding && !keepsOuter(binding) ? binding : `global:${node.name}`;
  };
  const found = new Set();
  const add = (node) => {
    const specifier = specifierOf(node);
    if (specifier) found.add(specifier);
  };
  const walk = (node, step) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, step);
      return;
    }
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    step(node);
    for (const [key, child] of Object.entries(node)) if (!NOT_CHILDREN.has(key)) walk(child, step);
  };
  // The function a callee names. Compilers wrap an imported function as `(0, ns.fn)(…)`, so it is not called as a method
  // (TypeScript's CommonJS output: `(0, node_module_1.createRequire)(__filename)`).
  const unwrap = (node) =>
    node?.type === 'SequenceExpression' ? unwrap(node.expressions.at(-1)) : node?.type === 'ParenthesizedExpression' ? unwrap(node.expression) : node;
  const isMember = (node) => node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression';
  /** A name written in the source: an identifier, or a string or substitution-free template. */
  const staticName = (node) =>
    node?.type === 'StringLiteral'
      ? node.value
      : node?.type === 'TemplateLiteral' && node.expressions.length === 0
        ? node.quasis[0].value.cooked
        : undefined;
  /** A key that names a property: `a.b`, `a['b']`, ``a[`b`]`` → "b"; `a[b]` names no fixed property. */
  const keyName = (key, computed) => (!computed && key?.type === 'Identifier' ? key.name : staticName(key));
  const propertyName = (member) => keyName(member.property, member.computed);
  // The bindings a require function is bound to: Node's own `require` (when the file does not declare that name), and
  // those found below.
  const requires = new Set(['global:require']);
  // `.require()` loads a module only on Node's own objects (`module.require`, `require.main.require`,
  // `globalThis.require`); on an ordinary object (`validator.require('field')`) it is a method like any other.
  const NODE_OBJECTS = new Set(['global:module', 'global:global', 'global:globalThis']);
  // The receiver itself must be one of Node's: `module`, `global`, `globalThis` or a require function, or the module
  // reached from one (`require.main`, `module.parent`). Not anything rooted there: `module.exports.require` is the
  // package's own export.
  const isNodeReceiver = (node) => {
    const inner = unwrap(node);
    if (inner?.type === 'TSNonNullExpression') return isNodeReceiver(inner.expression);
    if (inner?.type === 'Identifier') return NODE_OBJECTS.has(keyOf(inner)) || requires.has(keyOf(inner));
    if (isMember(inner)) return ['main', 'parent'].includes(propertyName(inner)) && isNodeReceiver(inner.object);
    // Any other expression that yields a require function, such as minified Rolldown's
    // `e(import.meta.url).main.require(…)` with `e` imported as createRequire.
    return yieldsRequire(inner);
  };
  const isRequireMethod = (callee) => isMember(callee) && propertyName(callee) === 'require' && isNodeReceiver(callee.object);

  // createRequire, wherever it comes from. Tracing whether a value is really Node's `module` builtin through compilers'
  // interop helpers (tsc's `__importDefault`, Babel's `_interopRequire*`, SWC's helpers, esbuild's and Rolldown's
  // `__toESM`, Rollup's `_interopDefault`), each of which a minifier may rename or wrap, misses real output. So the guard
  // fails safe instead: a missed load ships a forbidden dependency silently, while a false match fails our own build
  // loudly. Any member call named `createRequire` (`m.createRequire(…)`, `(0, node_module_1.createRequire)(…)`,
  // `e._(require("node:module")).default.createRequire(…)`), and any name imported or destructured as `createRequire`
  // (`import { createRequire as cr }`, `const { createRequire: cr } = …`), makes a require function. The cost is that
  // an object's own method of that name (`factory.createRequire()`) is read as one too; a local function merely named
  // `createRequire` is not, since it is its own binding.
  const makers = new Set();
  const bindMakers = () =>
    walk(ast.program, (node) => {
      if (node.type === 'ImportDeclaration') {
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier' && keyName(specifier.imported, false) === 'createRequire') makers.add(keyOf(specifier.local));
        }
      }
      if (node.type === 'ObjectPattern') {
        for (const property of node.properties) {
          if (property.type !== 'ObjectProperty' || keyName(property.key, property.computed) !== 'createRequire') continue;
          // `{ createRequire: cr }`, or with a default: `{ createRequire: cr = undefined }`.
          const local = property.value.type === 'AssignmentPattern' ? property.value.left : property.value;
          if (local.type === 'Identifier') makers.add(keyOf(local));
        }
      }
    });
  // `cr(…)`, `m.createRequire(…)` or `(0, node_module_1.createRequire)(…)`: its result is a require function.
  const makesRequire = (node) => {
    if (node?.type !== 'CallExpression' && node?.type !== 'OptionalCallExpression') return false;
    const callee = unwrap(node.callee);
    if (callee.type === 'Identifier') return makers.has(keyOf(callee));
    return isMember(callee) && propertyName(callee) === 'createRequire';
  };
  const isFunction = (node) => node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression';
  // The values a function returns: an arrow's expression body, or each `return` in its own body (not in nested functions).
  const returnsOf = (fn) => {
    if (fn.body.type !== 'BlockStatement') return [fn.body];
    const values = [];
    const look = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) look(item);
        return;
      }
      if (typeof node.type !== 'string' || isFunction(node) || node.type === 'FunctionDeclaration' || node.type === 'ClassBody') return;
      if (node.type === 'ReturnStatement' && node.argument) values.push(node.argument);
      for (const [key, child] of Object.entries(node)) if (!NOT_CHILDREN.has(key)) look(child);
    };
    look(fn.body.body);
    return values;
  };
  /**
   * Whether an expression can evaluate to a require function, as opposed to merely using one (`require.cache[id]`,
   * `typeof require`) or holding a method of that name (`{ require(x) {…} }`). It does when it is a require binding,
   * a createRequire call, either branch of a `?:`, either side of `||` / `??`, the right of `&&` (a require function is
   * truthy, so `a && b` only ever yields it as `b`), the last of a comma expression, an assignment's value, or a call of
   * a function expression that returns one. That last case is a bundler's helper: Rolldown's
   * `(() => createRequire(import.meta.url))()` and esbuild's
   * `((x) => typeof require !== "undefined" ? require : …)(function (x) { … })`.
   */
  const yieldsRequire = (node, depth = 0) => {
    const value = unwrap(node);
    if (!value || depth > 20) return false;
    if (value.type === 'Identifier') return requires.has(keyOf(value));
    if (makesRequire(value)) return true;
    if (value.type === 'ConditionalExpression') return yieldsRequire(value.consequent, depth + 1) || yieldsRequire(value.alternate, depth + 1);
    if (value.type === 'LogicalExpression') {
      return (value.operator !== '&&' && yieldsRequire(value.left, depth + 1)) || yieldsRequire(value.right, depth + 1);
    }
    if (value.type === 'AssignmentExpression') return yieldsRequire(value.right, depth + 1);
    if ((value.type === 'CallExpression' || value.type === 'OptionalCallExpression') && isFunction(unwrap(value.callee))) {
      return returnsOf(unwrap(value.callee)).some((returned) => yieldsRequire(returned, depth + 1));
    }
    return false;
  };
  // The names a require function is bound to: made by createRequire, or given one (`const r = require`, esbuild's
  // `__require`). Repeated until nothing new is found, since one binding can be given another.
  // The makers depend on nothing found here, so they are collected once.
  bindMakers();
  for (let size = -1; size !== requires.size; ) {
    size = requires.size;
    walk(ast.program, (node) => {
      const [target, value] =
        node.type === 'VariableDeclarator' ? [node.id, node.init] : node.type === 'AssignmentExpression' ? [node.left, node.right] : [];
      if (target?.type === 'Identifier' && !requires.has(keyOf(target)) && yieldsRequire(value)) requires.add(keyOf(target));
    });
  }
  const loads = (node) => {
    const callee = unwrap(node);
    if (callee.type === 'Import' || (callee.type === 'Identifier' && requires.has(keyOf(callee)))) return true;
    if (isMember(callee) && propertyName(callee) === 'require') return isRequireMethod(callee);
    // `createRequire(import.meta.url)('x')`, Rolldown's `(() => createRequire(import.meta.url))()('x')`
    return yieldsRequire(callee);
  };
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
    // Only built code ships: JavaScript, declarations and their source maps under dist/, plus the package's metadata,
    // readme, licence and changelog at the top. Source (src/, lib/helper.ts, a .ts beside dist/) is refused wherever it is.
    for (const path of files.keys()) {
      const shipped = path.startsWith('dist/') ? DIST_FILE.test(path) : TOP_LEVEL_FILE.test(path);
      if (!shipped)
        fail(`ships ${path}: only dist/ JavaScript, declarations and source maps, and package.json, README, LICENSE and CHANGELOG are published`);
    }

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
