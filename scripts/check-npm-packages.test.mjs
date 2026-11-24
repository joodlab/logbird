import assert from 'node:assert/strict';
import test from 'node:test';
import { importsOf } from './check-npm-packages.mjs';

// U+2028 and U+2029 end a line comment, as LF and CR do. Built here so the source shows them.
const LINE_SEPARATOR = String.fromCharCode(8232); // U+2028
const PARAGRAPH_SEPARATOR = String.fromCharCode(8233); // U+2029
// Each shipped form of an import, in JavaScript (.mjs) or a declaration (.d.mts), and the specifier it must report.
const IMPORTS = [
  ['import { z } from "zod";', 'zod'],
  ['import{z}from"zod";', 'zod'],
  ['export*from"@logbird/contracts";', '@logbird/contracts'],
  ['export { parse } from "@logbird/contracts/query-syntax";', '@logbird/contracts/query-syntax'],
  ['import"zod";', 'zod'],
  ['import/* generated */"zod";', 'zod'],
  ['import// generated\n"zod";', 'zod'],
  ['import// generated\r"zod";', 'zod'],
  [`import// generated${LINE_SEPARATOR}"zod";`, 'zod'],
  [`import// generated${PARAGRAPH_SEPARATOR}"zod";`, 'zod'],
  ['import {z} /* here\'s why */ from "zod";', 'zod'],
  ["const z = await import('zod');", 'zod'],
  ["const z = await import('zod', { with: { type: 'json' } });", 'zod'],
  ['const z = await import(`zod`);', 'zod'],
  ['const z = await import(`zod/foo$bar`);', 'zod/foo$bar'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the code under test is a template literal with a substitution
  ["const x = 'v4'; const z = await import(`zod/${x}`);", 'zod'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the code under test is a template literal with a substitution
  ["const x = 'v4'; const z = await import(`@logbird/contracts/${x}`);", '@logbird/contracts'],
  ['const c = require(`@logbird/contracts`);', '@logbird/contracts'],
  ["const c = require('zod');", 'zod'],
  ["const c = require?.('zod');", 'zod'],
  ["import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load('zod');", ['node:module', 'zod']],
  ["import { createRequire } from 'node:module'; let load; load = createRequire(import.meta.url); load?.('zod');", ['node:module', 'zod']],
  ["import { createRequire } from 'node:module'; createRequire(import.meta.url)('zod');", ['node:module', 'zod']],
  ["import module from 'node:module'; const load = module.createRequire(import.meta.url); load('zod');", ['node:module', 'zod']],
  ["import { createRequire as cr } from 'node:module'; const load = cr(import.meta.url); load('zod');", ['node:module', 'zod']],
  ["const { createRequire: cr } = require('node:module'); cr(__filename)('zod');", ['node:module', 'zod']],
  ["module.require('zod');", 'zod'],
  ["(0, require)('zod');", 'zod'],
];
const DECLARATION_IMPORTS = [
  ["import type {\n  ZodType,\n  infer as Infer\n} from 'zod';", 'zod'],
  ['export type Z = import("zod").ZodType;', 'zod'],
  ['/// <reference types="zod" />\nexport {};', 'zod'],
  // TypeScript reads the directive's attributes in any order.
  ['/// <reference preserve="true" types="zod" />\nexport {};', 'zod'],
  ['// generated\n/// <reference types="zod" />\nexport {};', 'zod'],
  ['import z = require("zod");', 'zod'],
];
// Text that mentions a package but imports nothing.
const NOT_IMPORTS = [
  'export const migrationNote = "Migrated from \'zod\' in v2";',
  'export const migrationNote = "We used to import types from \'zod\' in v2";',
  'const hint = \'Load it from "@logbird/contracts" instead\';',
  "const t = `moved from 'zod' to built-in checks`;",
  "// import { z } from 'zod' was removed in 0.2",
  "/* require('zod') was removed */",
  'const s = "import(\'zod\')";',
  "export const p = () => import('./zod-free.mjs');",
  "const x = 'zod'; const z = await import(x);",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the code under test is a template literal with a substitution
  'const z = await import(`${name}/sub`);',
];

test('every form of a JavaScript import is reported', () => {
  for (const [code, specifier] of IMPORTS) assert.deepEqual(importsOf(code, 'dist/index.mjs'), [specifier].flat(), code);
});

test('every form of a declaration import is reported', () => {
  for (const [code, specifier] of DECLARATION_IMPORTS) assert.deepEqual(importsOf(code, 'dist/index.d.mts'), [specifier], code);
});

test('a string, a comment, a relative path or a computed specifier is not an import', () => {
  for (const code of NOT_IMPORTS) assert.deepEqual(importsOf(code, 'dist/index.mjs'), [], code);
});

test("TypeScript's CommonJS output of a createRequire import is read", () => {
  // `tsc --module nodenext` (TypeScript 6) output for a .cts that does
  // `import { createRequire } from 'node:module'; const load = createRequire(__filename); export const z = load('zod');`
  const emitted = [
    '"use strict";',
    'Object.defineProperty(exports, "__esModule", { value: true });',
    'exports.z = void 0;',
    'const node_module_1 = require("node:module");',
    'const load = (0, node_module_1.createRequire)(__filename);',
    "exports.z = load('zod');",
  ].join('\n');
  assert.deepEqual(importsOf(emitted, 'dist/probe.cjs'), ['node:module', 'zod']);
});

test("esbuild's ESM output of a CommonJS entry is read, through its __require helper", () => {
  // esbuild 0.28.2: bundle: true, platform: 'node', format: 'esm', packages: 'external', with the usual createRequire
  // banner, for an entry that does `require('fictional-library')` and `require.main.require('fictional-other')`.
  const emitted = [
    "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    'var __getOwnPropNames = Object.getOwnPropertyNames;',
    'var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {',
    '  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]',
    '}) : x)(function(x) {',
    '  if (typeof require !== "undefined") return require.apply(this, arguments);',
    "  throw Error('Dynamic require of \"' + x + '\" is not supported');",
    '});',
    'var __commonJS = (cb, mod) => function __require2() {',
    '  try {',
    '    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;',
    '  } catch (e) {',
    '    throw mod = 0, e;',
    '  }',
    '};',
    'var require_entry = __commonJS({',
    '  "entry.cjs"(exports, module) {',
    '    var z = __require("fictional-library");',
    '    module.exports = { z, main: __require.main.require("fictional-other") };',
    '  }',
    '});',
    'export default require_entry();',
  ].join('\n');
  assert.deepEqual(importsOf(emitted, 'dist/index.mjs'), ['node:module', 'fictional-library', 'fictional-other']);
});

test('require.main.require and module.parent.require load modules', () => {
  // tsc emits `require.main!.require(…)` as `require.main.require(…)`; the declaration form keeps the `!`.
  assert.deepEqual(importsOf("const x = require.main.require('fictional-library');", 'dist/probe.cjs'), ['fictional-library']);
  assert.deepEqual(importsOf("const x = module.parent?.require('fictional-library');", 'dist/probe.cjs'), ['fictional-library']);
  assert.deepEqual(importsOf("const r = require; r('fictional-library');", 'dist/probe.cjs'), ['fictional-library']);
});

test('a static computed property names the method: module[`require`] and module["require"]', () => {
  assert.deepEqual(importsOf("module[`require`]('zod');", 'dist/probe.cjs'), ['zod']);
  assert.deepEqual(importsOf("module['require']('zod');", 'dist/probe.cjs'), ['zod']);
  // `module[name]` names no fixed property.
  assert.deepEqual(importsOf("const name = 'other'; module[name]('fictional-field');", 'dist/probe.cjs'), []);
});

test('createRequire counts only from node:module', () => {
  assert.deepEqual(importsOf("require('node:module').createRequire(__filename)('zod');", 'dist/probe.cjs'), ['zod', 'node:module']);
  // An ordinary object's own method named createRequire makes nothing.
  const factory = "const factory = { createRequire: () => (f) => f }; const validate = factory.createRequire(); validate('fictional-field');";
  assert.deepEqual(importsOf(factory, 'dist/index.mjs'), []);
  const ownFunction = "function createRequire() { return (f) => f; } const validate = createRequire(); validate('fictional-field');";
  assert.deepEqual(importsOf(ownFunction, 'dist/index.mjs'), []);
});

test('a value that only tests for require is not a require function', () => {
  assert.deepEqual(importsOf("const hasRequire = typeof require === 'function'; hasRequire('fictional-library');", 'dist/probe.cjs'), []);
});

test('a method named require on an ordinary object is not an import', () => {
  assert.deepEqual(importsOf("const validator = { require: (f) => f }; validator.require('fictional-field');", 'dist/index.mjs'), []);
});

test('a reference directive after the first statement is not read, as TypeScript does not read it', () => {
  assert.deepEqual(importsOf('export {};\n/// <reference types="zod" />', 'dist/index.d.mts'), []);
});

test('each file is parsed as Node loads it: .mjs a module, .cjs a script, .js by its package type', () => {
  // `with` is a syntax error in a module, so a module file holding it fails instead of being read as a script.
  assert.throws(() => importsOf('with ({}) {}', 'dist/probe.js', 'module'));
  assert.throws(() => importsOf('with ({}) {}', 'dist/probe.mjs'));
  assert.deepEqual(importsOf("with ({}) {}\nrequire('zod');", 'dist/probe.js', 'commonjs'), ['zod']);
  assert.deepEqual(importsOf("const z = require('zod');\nreturn;", 'dist/probe.cjs'), ['zod']);
  // Node wraps CommonJS in a function, so `new.target` is valid at its top level.
  assert.deepEqual(importsOf("module.exports = new.target;\nrequire('zod');", 'dist/probe.cjs'), ['zod']);
  assert.deepEqual(importsOf("import 'zod';", 'dist/probe.js', 'module'), ['zod']);
  assert.throws(() => importsOf("import 'zod';", 'dist/probe.cjs'));
  assert.deepEqual(importsOf("import type { Z } from 'zod';\nexport type { Z };", 'dist/index.d.cts'), ['zod']);
});

test('a file that does not parse throws, so the check cannot skip it', () => {
  assert.throws(() => importsOf('const = ;', 'dist/index.mjs'));
});
