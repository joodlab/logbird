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

test('any createRequire makes a require function, wherever it comes from (fail-safe)', () => {
  assert.deepEqual(importsOf("require('node:module').createRequire(__filename)('zod');", 'dist/probe.cjs'), ['zod', 'node:module']);
  // Deliberately fail-safe: an object's own method named createRequire is read as Node's too, since telling the two apart
  // through minified interop helpers missed real loads. The match fails our own build loudly instead of shipping a load.
  const factory = "const factory = { createRequire: () => (f) => f }; const validate = factory.createRequire(); validate('fictional-field');";
  assert.deepEqual(importsOf(factory, 'dist/index.mjs'), ['fictional-field']);
  // Rolldown 1.2.16's output through Node's named `Module` export, and the same as an alias, `default`, and destructured.
  const viaModule = 'import { Module } from "node:module";\nconst x = Module.createRequire(import.meta.url)("fictional-library");\nexport { x };';
  assert.deepEqual(importsOf(viaModule, 'dist/index.mjs'), ['node:module', 'fictional-library']);
  const aliased =
    "import { Module as M, default as d } from 'node:module'; M.createRequire(import.meta.url)('zod'); d.createRequire(import.meta.url)('zod');";
  assert.deepEqual(importsOf(aliased, 'dist/index.mjs'), ['node:module', 'zod']);
  const destructured = "const { Module } = require('node:module'); Module.createRequire(__filename)('zod');";
  assert.deepEqual(importsOf(destructured, 'dist/probe.cjs'), ['node:module', 'zod']);
  // The same rule, whatever the receiver: a factory given 'node:module', or node:module itself, or ignoring it.
  const given =
    "const factory = () => ({ createRequire: () => (value) => value }); const object = factory('node:module'); const validate = object.createRequire(); validate('fictional-field');";
  assert.deepEqual(importsOf(given, 'dist/index.mjs'), ['fictional-field']);
  const wrapped =
    "const factory = () => ({ createRequire: () => (value) => value }); const object = factory(require('node:module')); const validate = object.createRequire(); validate('fictional-field');";
  assert.deepEqual(importsOf(wrapped, 'dist/probe.cjs'), ['node:module', 'fictional-field']);
  // `await import('node:module')`, and esbuild / Rolldown's __toESM wrapper, are node:module.
  const awaited = "const m = await import('node:module'); m.createRequire(import.meta.url)('zod');";
  assert.deepEqual(importsOf(awaited, 'dist/index.mjs'), ['node:module', 'zod']);
  const toEsm = "var import_node_module = __toESM(require('node:module')); (0, import_node_module.createRequire)(__filename)('zod');";
  assert.deepEqual(importsOf(toEsm, 'dist/probe.cjs'), ['node:module', 'zod']);
  const ignoring =
    "const factory = (m) => ({ createRequire: () => (value) => value }); const object = factory(require('node:module')); object.createRequire()('fictional-field');";
  assert.deepEqual(importsOf(ignoring, 'dist/probe.cjs'), ['node:module', 'fictional-field']);
  // esbuild 0.28.2, minified CommonJS: `__toESM` is renamed `b`.
  const minified =
    'var f=Object.create;var t=Object.defineProperty;var l=Object.getOwnPropertyDescriptor;var n=Object.getOwnPropertyNames;var p=Object.getPrototypeOf,q=Object.prototype.hasOwnProperty;var _=(e,r)=>{for(var i in r)t(e,i,{get:r[i],enumerable:!0})},m=(e,r,i,a)=>{if(r&&typeof r=="object"||typeof r=="function")for(let o of n(r))!q.call(e,o)&&o!==i&&t(e,o,{get:()=>r[o],enumerable:!(a=l(r,o))||a.enumerable});return e};var b=(e,r,i)=>(i=e!=null?f(p(e)):{},m(r||!e||!e.__esModule?t(i,"default",{value:e,enumerable:!0}):i,e)),s=e=>m(t({},"__esModule",{value:!0}),e);var x={};_(x,{q:()=>u});module.exports=s(x);var c=b(require("node:module"),1),u=c.default.createRequire(__filename)("fictional-library");0&&(module.exports={q});';
  assert.deepEqual(importsOf(minified, 'dist/probe.cjs'), ['node:module', 'fictional-library']);
  // Rollup 4.67.5, format cjs, interop auto: the module is bound first, then wrapped.
  const rollupInterop = [
    "'use strict';",
    "var m = require('node:module');",
    'function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }',
    'var m__default = /*#__PURE__*/_interopDefault(m);',
    "const q = m__default.default.createRequire(__filename)('fictional-library');",
    'exports.q = q;',
  ].join('\n');
  assert.deepEqual(importsOf(rollupInterop, 'dist/probe.cjs'), ['node:module', 'fictional-library']);
  // tsc 6 with esModuleInterop and importHelpers: the helper is a member of tslib.
  const tslib = [
    '"use strict";',
    'Object.defineProperty(exports, "__esModule", { value: true });',
    'exports.b = exports.a = void 0;',
    'const tslib_1 = require("tslib");',
    'const node_module_1 = require("node:module");',
    'const node_module_2 = tslib_1.__importDefault(require("node:module"));',
    "exports.a = (0, node_module_1.createRequire)(__filename)('fictional-a');",
    "exports.b = node_module_2.default.createRequire(__filename)('fictional-b');",
  ].join('\n');
  assert.deepEqual(importsOf(tslib, 'dist/probe.cjs'), ['tslib', 'node:module', 'fictional-a', 'fictional-b']);
  // SWC's helper, local or imported from @swc/helpers.
  const swc =
    'function _interop_require_default(obj) { return obj && obj.__esModule ? obj : { default: obj }; }\nconst _nodemodule = /*#__PURE__*/ _interop_require_default(require("node:module"));\n_nodemodule.default.createRequire(__filename)("zod");';
  assert.deepEqual(importsOf(swc, 'dist/probe.cjs'), ['node:module', 'zod']);
  const swcHelpers =
    'const _interop_require_default = require("@swc/helpers/_/_interop_require_default");\nconst _nodemodule = /*#__PURE__*/ _interop_require_default._(require("node:module"));\n_nodemodule.default.createRequire(__filename)("zod");';
  assert.deepEqual(importsOf(swcHelpers, 'dist/probe.cjs'), ['@swc/helpers/_/_interop_require_default', 'node:module', 'zod']);
  // tsc's esModuleInterop output and Node's getBuiltinModule are loads of node:module.
  const interop =
    'const node_module_1 = __importDefault(require("node:module")); const load = (0, node_module_1.default.createRequire)(__filename); load("zod");';
  assert.deepEqual(importsOf(interop, 'dist/probe.cjs'), ['node:module', 'zod']);
  const builtin = "const { createRequire } = process.getBuiltinModule('node:module'); createRequire(__filename)('zod');";
  assert.deepEqual(importsOf(builtin, 'dist/probe.cjs'), ['zod']);
  // Minified with esbuild: tsc's guarded helper (`var t=exports&&exports.__importDefault||function(e){…}`) and SWC's
  // external helper with its receiver renamed (`e._(require("node:module"))`).
  const tscMinified =
    '"use strict";var t=exports&&exports.__importDefault||function(e){return e&&e.__esModule?e:{default:e}};Object.defineProperty(exports,"__esModule",{value:!0}),exports.t=void 0;const u=t(require("node:module"));exports.t=u.default.createRequire(__filename)("fictional-target");';
  assert.deepEqual(importsOf(tscMinified, 'dist/probe.cjs'), ['node:module', 'fictional-target']);
  const swcMinified =
    'const e=require("@swc/helpers/_/_interop_require_default"),r=e._(require("node:module"));exports.t=r.default.createRequire(__filename)("fictional-target");';
  assert.deepEqual(importsOf(swcMinified, 'dist/probe.cjs'), ['@swc/helpers/_/_interop_require_default', 'node:module', 'fictional-target']);
  // A local function merely named createRequire is its own binding, not one imported or destructured as it.
  const ownFunction = "function createRequire() { return (f) => f; } const validate = createRequire(); validate('fictional-field');";
  assert.deepEqual(importsOf(ownFunction, 'dist/index.mjs'), []);
});

test("Rolldown's ESM output of a require call is read", () => {
  // Rolldown 1.2.16, platform 'node', format 'esm', the dependency external, for `export const x = require('fictional-library');`.
  const emitted = [
    'import { createRequire } from "node:module";',
    '// entry.js',
    'const x = (/* @__PURE__ */ (() => createRequire(import.meta.url))())("fictional-library");',
    'export { x };',
  ].join('\n');
  assert.deepEqual(importsOf(emitted, 'dist/index.mjs'), ['node:module', 'fictional-library']);
});

test('code that uses require, or has a method of that name, is not a require function', () => {
  const cases = [
    "const validator = { require(x) { return x; } }; validator.require('fictional-field');",
    "const inCache = (id) => Boolean(require.cache[id]); inCache('fictional-key');",
    "const resolve = (id) => require.resolve(id); resolve('fictional-key');",
    "const load = (id) => { const m = require(id); return m.default; }; load('fictional-key');",
  ];
  for (const code of cases) assert.deepEqual(importsOf(code, 'dist/probe.cjs'), [], code);
});

test("esbuild's ESM output of a CommonJS createRequire is read, through __require('node:module')", () => {
  // esbuild 0.28.2, as above, for `var { createRequire } = require('node:module');
  // module.exports = createRequire(__filename)('fictional-library');`.
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
    'var require_entry2 = __commonJS({',
    '  "entry2.cjs"(exports, module) {',
    '    var { createRequire } = __require("node:module");',
    '    module.exports = createRequire(__filename)("fictional-library");',
    '  }',
    '});',
    'export default require_entry2();',
  ].join('\n');
  assert.deepEqual(importsOf(emitted, 'dist/index.mjs'), ['node:module', 'fictional-library']);
});

test('a parameter or local that shadows a require function is its own binding', () => {
  const shadowed = [
    "import { createRequire } from 'node:module';",
    'const load = createRequire(import.meta.url);',
    "load('node:fs');",
    'export function validate(load) {',
    "  return load('fictional-field');",
    '}',
  ].join('\n');
  assert.deepEqual(importsOf(shadowed, 'dist/index.mjs'), ['node:module', 'node:fs']);
  // A parameter named require is not Node's require; the file's own require still is.
  assert.deepEqual(importsOf("function run(require) { return require('fictional-field'); }\nrequire('zod');", 'dist/probe.cjs'), ['zod']);
});

test("a top-level `var require;` keeps CommonJS's require; one given a value does not", () => {
  assert.deepEqual(importsOf("var require;\nrequire('zod');", 'dist/probe.cjs'), ['zod']);
  assert.deepEqual(importsOf("var require = (x) => x;\nrequire('fictional-field');", 'dist/probe.cjs'), []);
  assert.deepEqual(importsOf("var require;\nrequire = (x) => x;\nrequire('fictional-field');", 'dist/probe.cjs'), []);
  assert.deepEqual(importsOf("var require;\nfunction run(require) { return require('fictional-field'); }\nrequire('zod');", 'dist/probe.cjs'), [
    'zod',
  ]);
});

test("the CommonJS wrapper's require survives only in CommonJS, and only bare redeclarations", () => {
  // Repeated bare declarations replace nothing.
  assert.deepEqual(importsOf("var require; var require;\nrequire('zod');", 'dist/probe.cjs'), ['zod']);
  // A module has no wrapper: a bare `var require;` there is undefined and loads nothing.
  assert.deepEqual(importsOf("var require;\nrequire?.('fictional-field');", 'dist/index.mjs'), []);
  // A loop head gives it each item: `require` is then a local function.
  assert.deepEqual(importsOf("for (var require of [(x) => x]) {\n  require('fictional-field');\n}", 'dist/probe.cjs'), []);
  assert.deepEqual(importsOf("for (var require in { a: 1 }) {\n  require('fictional-field');\n}", 'dist/probe.cjs'), []);
  // Only the wrapper's names are kept: a bare `var globalThis;` is a new, undefined variable.
  assert.deepEqual(importsOf("var globalThis;\nglobalThis?.require('fictional-field');", 'dist/probe.cjs'), []);
  assert.deepEqual(importsOf("var module;\nmodule.require('zod');", 'dist/probe.cjs'), ['zod']);
  // A later declaration with a value is its own function.
  assert.deepEqual(importsOf("var require;\nvar require = (x) => x;\nrequire('fictional-field');", 'dist/probe.cjs'), []);
});

test('.require() counts on Node objects and the modules reached from them, not on anything rooted there', () => {
  assert.deepEqual(importsOf("module.exports = { require: (x) => x };\nmodule.exports.require('fictional-field');", 'dist/probe.cjs'), []);
  assert.deepEqual(importsOf("module.parent.require('zod'); require.main.require('zod');", 'dist/probe.cjs'), ['zod']);
  // Any module reached from one, fail-safe: children by index or method, and the require cache.
  assert.deepEqual(importsOf("require('./child.cjs');\nmodule.children[0].require('zod');", 'dist/probe.cjs'), ['zod']);
  assert.deepEqual(importsOf("module.children.at(-1).require('zod');", 'dist/probe.cjs'), ['zod']);
  assert.deepEqual(importsOf("require.cache[__filename].require('zod');", 'dist/probe.cjs'), ['zod']);
  // `exports` is the package's own value, however it is reached.
  assert.deepEqual(importsOf("module.exports.helper.require('fictional-field');", 'dist/probe.cjs'), []);
  // Rolldown 1.2.16, minified ESM, for `require.main.require('fictional-library')`: the receiver is a createRequire call.
  const rolldownMinified =
    'import{createRequire as e}from"node:module";const t=(/* @__PURE__ */ e(import.meta.url)).main.require(`fictional-library`);export{t as z};';
  assert.deepEqual(importsOf(rolldownMinified, 'dist/index.mjs'), ['node:module', 'fictional-library']);
});

test('a defaulted createRequire binding is still a maker', () => {
  const code = "const { createRequire: cr = undefined } = require('node:module');\ncr(__filename)('zod');";
  assert.deepEqual(importsOf(code, 'dist/probe.cjs'), ['node:module', 'zod']);
});

test('require.main.require loading node:module makes createRequire available', () => {
  const code = "const { createRequire } = require.main.require('node:module');\nconst load = createRequire(__filename);\nload('zod');";
  assert.deepEqual(importsOf(code, 'dist/probe.cjs'), ['node:module', 'zod']);
  // An ordinary object's `require` method loads nothing, but what is destructured as createRequire counts (fail-safe).
  const ordinary =
    "const loader = { require: () => ({ createRequire: () => (f) => f }) }; const { createRequire } = loader.require('node:module'); createRequire()('fictional-field');";
  assert.deepEqual(importsOf(ordinary, 'dist/probe.cjs'), ['fictional-field']);
  assert.deepEqual(importsOf("const loader = { require: (x) => x }; loader.require('fictional-field');", 'dist/probe.cjs'), []);
});

test('the left of && is not what it yields', () => {
  assert.deepEqual(importsOf("const validate = require && ((field) => field); validate('fictional-field');", 'dist/probe.cjs'), []);
  assert.deepEqual(importsOf("const load = (typeof require === 'function' && require) || null; load('zod');", 'dist/probe.cjs'), ['zod']);
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
