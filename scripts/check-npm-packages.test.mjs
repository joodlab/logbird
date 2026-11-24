import assert from 'node:assert/strict';
import test from 'node:test';
import { importsOf } from './check-npm-packages.mjs';

// U+2028 and U+2029 end a line comment, as LF and CR do. Built here so the source shows them.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
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
];
const DECLARATION_IMPORTS = [
  ["import type {\n  ZodType,\n  infer as Infer\n} from 'zod';", 'zod'],
  ['export type Z = import("zod").ZodType;', 'zod'],
  ['/// <reference types="zod" />\nexport {};', 'zod'],
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
  for (const [code, specifier] of IMPORTS) assert.deepEqual(importsOf(code, 'dist/index.mjs'), [specifier], code);
});

test('every form of a declaration import is reported', () => {
  for (const [code, specifier] of DECLARATION_IMPORTS) assert.deepEqual(importsOf(code, 'dist/index.d.mts'), [specifier], code);
});

test('a string, a comment, a relative path or a computed specifier is not an import', () => {
  for (const code of NOT_IMPORTS) assert.deepEqual(importsOf(code, 'dist/index.mjs'), [], code);
});

test('a file that does not parse throws, so the check cannot skip it', () => {
  assert.throws(() => importsOf('const = ;', 'dist/index.mjs'));
});
