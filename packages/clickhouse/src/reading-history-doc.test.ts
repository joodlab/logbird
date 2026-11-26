import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// docs/reading-history.md is a guide a stranger follows with a read key. This keeps two things in it honest: every curl
// calls a public route with only query parameters that route documents and authenticates with a key variable, and every
// limit it quotes is the number docs/limits.md states (which limits-doc.test.ts checks against the code). It does not
// run the recipes.
const root = new URL('../../../', import.meta.url);
const guide = readFileSync(new URL('docs/reading-history.md', root), 'utf8');
const limits = readFileSync(new URL('docs/limits.md', root), 'utf8');
const openapi = JSON.parse(readFileSync(new URL('openapi/public.json', root), 'utf8')) as {
  paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
};

/** The shell blocks of the guide, with line continuations joined. */
const shell = [...guide.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)].map((m) => (m[1] ?? '').replace(/\\\n\s*/g, ' '));
/** Every curl command in those blocks (comment lines aside). */
const curls = shell.flatMap((block) => block.split('\n')).filter((line) => !line.trimStart().startsWith('#') && /\bcurl\s/.test(line));
/** The one header variable a block may define, and the only values it may hold. */
const READ_HEADER = /^Authorization: Bearer \$LOGBIRD_(?:READ|MASKED)_KEY$/;

/** The OpenAPI path a URL in the guide addresses (`/v1/events/evt_1` is `/v1/events/{eventId}`). */
function operation(url: string) {
  const path = url.replace(/^"?\$LOGBIRD_URL/, '').replace(/["?].*$/, '');
  const match = Object.keys(openapi.paths).find((template) => new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path));
  return { path, template: match, get: match ? openapi.paths[match]?.get : undefined };
}

it('calls only public read routes, with every parameter documented by its route', () => {
  expect(curls.length).toBeGreaterThan(10);
  for (const line of curls) {
    const url = line.match(/"\$LOGBIRD_URL[^"]*"/)?.[0];
    expect(url, line).toBeDefined();
    const { path, template, get } = operation(url as string);
    expect(template, `${path} is not in openapi/public.json`).toBeDefined();
    expect(get, `${path} has no GET in openapi/public.json`).toBeDefined();
    const documented = new Set((get?.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name));
    const args = [...line.matchAll(/--data-urlencode\s+(\S+)/g)].map((m) => m[1] as string);
    for (const arg of args) {
      const name = arg.match(/^['"]?([^=\s'"]+)=/)?.[1];
      expect(name, `${line}: cannot read the parameter name of ${arg}`).toBeDefined();
      expect(documented, `${path} has no query parameter "${name}"`).toContain(name);
    }
  }
});

it('authenticates every call with a read key variable, never a literal key', () => {
  for (const line of curls) {
    const headers = [...line.matchAll(/-H\s+"([^"]*)"/g)].map((m) => m[1] as string);
    expect(headers.length, line).toBeGreaterThan(0);
    for (const header of headers) {
      if (header === '$AUTH') continue;
      expect(header, line).toMatch(READ_HEADER);
    }
  }
  for (const [, value] of guide.matchAll(/AUTH="([^"]*)"/g)) expect(value).toMatch(READ_HEADER);
  for (const [line] of guide.matchAll(/^.*Authorization:.*$/gm)) expect(line).toMatch(/Authorization: Bearer \$LOGBIRD_(?:READ|MASKED)_KEY"/);
  expect(guide).not.toMatch(/lb_(?:read|ingest)_[A-Za-z0-9]{8,}/);
});

/** The value cell of the docs/limits.md table row whose first cell is `label`. */
function value(label: string) {
  const row = limits.split('\n').find((line) => line.startsWith(`| ${label} |`));
  if (!row) throw new Error(`docs/limits.md has no row "${label}"`);
  return row.split('|')[2]?.trim() ?? '';
}
const first = (label: string) => Number(value(label).match(/\d+/)?.[0]);
const defaultOf = (label: string) => Number(value(label).match(/\(default (\d+)\)/)?.[1]);

it('quotes the limits that docs/limits.md states', () => {
  const quoted = [
    `at most ${first('Targets indexed')} targets and ${first('Changes indexed')} changes, and a change field name of at most ${first('Change field name')} UTF-16 code units`,
    `A page holds at most ${first('Search page (`limit`)')} events (\`limit\`, default ${defaultOf('Search page (`limit`)')})`,
    `capped at ${first('Search count (`total`)')}`,
    `furthest first, at most ${first('Detail parent walk')}`,
    `(\`limit\`, default ${defaultOf('Facet values (`limit`)')}, at most ${first('Facet values (`limit`)')})`,
    `(\`byLimit\`, default ${defaultOf('Facet second level (`byLimit`)')}, at most ${first('Facet second level (`byLimit`)')})`,
    `reads only the ${first('Time window of search, facets and export without `from`')} hours before \`to\``,
    `past its ${first('Targets indexed')}th target`,
  ];
  for (const phrase of quoted) expect(guide.replace(/\s+/g, ' '), phrase).toContain(phrase);
});
