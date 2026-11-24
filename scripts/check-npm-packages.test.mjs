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

test('a reference directive after the first statement is not read, as TypeScript does not read it', () => {
  assert.deepEqual(importsOf('export {};\n/// <reference types="zod" />', 'dist/index.d.mts'), []);
});

test('each file is parsed as Node loads it: .mjs a module, .cjs a script, .js by its package type', () => {
  // `with` is a syntax error in a module, so a module file holding it fails instead of being read as a script.
  assert.throws(() => importsOf('with ({}) {}', 'dist/probe.js', 'module'));
  assert.throws(() => importsOf('with ({}) {}', 'dist/probe.mjs'));
  assert.deepEqual(importsOf("with ({}) {}\nrequire('zod');", 'dist/probe.js', 'commonjs'), ['zod']);
  assert.deepEqual(importsOf("const z = require('zod');\nreturn;", 'dist/probe.cjs'), ['zod']);
  assert.deepEqual(importsOf("import 'zod';", 'dist/probe.js', 'module'), ['zod']);
  assert.throws(() => importsOf("import 'zod';", 'dist/probe.cjs'));
  assert.deepEqual(importsOf("import type { Z } from 'zod';\nexport type { Z };", 'dist/index.d.cts'), ['zod']);
});

test('a file that does not parse throws, so the check cannot skip it', () => {
  assert.throws(() => importsOf('const = ;', 'dist/index.mjs'));
});
