import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { siteMap } from '../lib/site-map';

/**
 * marketing/copy holds the page briefs; the page text renders from the modules in this folder. This keeps the briefs
 * findable, as the inventory part of the removed copy-sync check did (#249, #250): every brief is in the README's file
 * table, every row links the file it names and that file exists, no file has two rows, and every page row names a page
 * of the site. Each page brief also starts, after its front matter, with the line naming the module its page renders
 * from, and every apps/web path on that line exists.
 */
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const COPY = join(REPO, 'marketing/copy');
const read = (file: string) => readFileSync(join(COPY, file), 'utf8');
/** The copy guide itself, not a brief. */
const NOT_LISTED = new Set(['README.md']);

function briefFiles(dir = COPY): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return briefFiles(path);
    return name.endsWith('.md') ? [relative(COPY, path).replaceAll('\\', '/')] : [];
  });
}

interface Row {
  file: string;
  link: string;
  /** The first route the row names, or undefined for "(not a page)". */
  route?: string;
}

/** The README's file table: `| [`file`](link) | page | routes |`. A malformed row fails. */
function indexRows(): Row[] {
  return read('README.md')
    .split('\n')
    .filter((line) => line.startsWith('| [`'))
    .map((line) => {
      const row = /^\| \[`([^`]+)`\]\(([^)]+)\) \| [^|]+ \| (.+?) \|$/.exec(line.trim());
      if (!row) throw new Error(`Malformed row in marketing/copy/README.md: ${line}`);
      const [, file = '', link = '', routes = ''] = row;
      return { file, link, route: routes.trim() === '(not a page)' ? undefined : /`([^`]+)`/.exec(routes)?.[1] };
    });
}

const MODULE_LINE =
  /^Page text renders from `apps\/web\/src\/content\/[^`]+\.ts`.*; edit it there\. This file is the brief: jobs, sources and owner notes\.$/;
/** The first line after the front matter. */
const firstLine = (text: string) =>
  text
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .split('\n')
    .find((line) => line.trim() !== '');

describe('marketing/copy briefs', () => {
  it('every brief is in the README index, and every index row links a file that exists', () => {
    const files = briefFiles();
    const rows = indexRows();
    expect(rows.length).toBeGreaterThan(20);
    expect(
      rows.filter((row) => row.link !== row.file).map((row) => `${row.file} links ${row.link}`),
      'rows whose link differs from the file they name',
    ).toEqual([]);
    expect(
      rows.map((row) => row.file).filter((file, index, all) => all.indexOf(file) !== index),
      'files with two rows',
    ).toEqual([]);
    expect(
      rows.filter((row) => !existsSync(join(COPY, row.link))).map((row) => row.link),
      'index links that do not resolve',
    ).toEqual([]);
    const listed = new Set(rows.map((row) => row.file));
    expect(
      files.filter((file) => !(NOT_LISTED.has(file) || listed.has(file))),
      'briefs missing from the README index',
    ).toEqual([]);
  });

  it('every page row names a page of the site', () => {
    const paths = new Set(siteMap.map((page) => page.path));
    const pageRows = indexRows().filter((row) => row.route !== undefined);
    expect(pageRows.length).toBeGreaterThan(20);
    expect(
      pageRows.filter((row) => !paths.has(row.route === '*' ? '/404' : (row.route as string))).map((row) => `${row.file}: ${row.route}`),
      'rows naming no page of the site',
    ).toEqual([]);
  });

  it('every page brief starts with the line naming its module, and the module exists', () => {
    for (const { file } of indexRows().filter((row) => row.route !== undefined)) {
      const line = firstLine(read(file)) ?? '';
      expect(line, `${file}: first line after the front matter`).toMatch(MODULE_LINE);
      for (const [, path = ''] of line.matchAll(/`(apps\/web\/[^`]+)`/g)) {
        expect(existsSync(join(REPO, path)), `${file} names ${path}, which does not exist`).toBe(true);
      }
    }
  });
});
