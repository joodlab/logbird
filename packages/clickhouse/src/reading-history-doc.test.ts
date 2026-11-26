import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// docs/reading-history.md is a guide a stranger follows with a read key. This keeps parts of it honest without running
// it: every call (curl or the guide's `lb` helper) reaches a public route with only query parameters that route
// documents, authenticates with a read key variable, and uses only shell variables an earlier line assigns; and every
// limit it quotes is the number docs/limits.md states (which limits-doc.test.ts checks against the code).
const root = new URL('../../../', import.meta.url);
const guide = readFileSync(new URL('docs/reading-history.md', root), 'utf8');
const limits = readFileSync(new URL('docs/limits.md', root), 'utf8');
const openapi = JSON.parse(readFileSync(new URL('openapi/public.json', root), 'utf8')) as {
  paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
};

/** The shell blocks of the guide, in order, with line continuations joined. */
const shell = [...guide.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)].map((m) => (m[1] ?? '').replace(/\\\n\s*/g, ' '));
const code = (line: string) => !line.trimStart().startsWith('#');
/** Every call in those blocks: curl, or the `lb` helper, except the helpers' own pass-through curl (`"$@"`). */
const calls = shell
  .flatMap((block) => block.split('\n'))
  .filter((line) => code(line) && /(?:^|[\s=;])(?:curl|lb)\s/.test(line) && !line.includes('"$@"') && !/^\s*lb\(\)/.test(line));
/** The only authorization headers a call may send. */
const READ_HEADER = /^Authorization: Bearer (?:\$LOGBIRD_(?:READ|MASKED|TENANT)_KEY|\$\{KEY:-\$LOGBIRD_READ_KEY\})$/;

/** The OpenAPI path a URL in the guide addresses (`/v1/events/evt_1` is `/v1/events/{eventId}`). */
function operation(url: string) {
  const path = url.replace(/^"?\$LOGBIRD_URL/, '').replace(/["?].*$/, '');
  const match = Object.keys(openapi.paths).find((template) => new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path));
  return { path, template: match, get: match ? openapi.paths[match]?.get : undefined };
}

it('calls only public read routes, with every parameter documented by its route', () => {
  expect(calls.length).toBeGreaterThan(15);
  for (const line of calls) {
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

it('authenticates every request with a read key variable, never a literal key', () => {
  const headers = shell.flatMap((block) => [...block.matchAll(/-H\s+"([^"]*)"/g)].map((m) => m[1] as string));
  expect(headers.length).toBeGreaterThan(2);
  for (const header of headers) if (header !== '$AUTH') expect(header).toMatch(READ_HEADER);
  for (const [, value] of guide.matchAll(/\bAUTH="([^"]*)"/g)) expect(value).toMatch(READ_HEADER);
  for (const line of calls) if (/\bcurl\s/.test(line)) expect(line, line).toMatch(/-H\s+"(?:Authorization: Bearer [^"]+|\$AUTH)"/);
  expect(guide).not.toMatch(/lb_(?:read|ingest)_[A-Za-z0-9]{8,}/);
});

/** A block's shell text without comments and single-quoted strings (jq and awk programs, literal values). */
const shellText = (block: string) =>
  block
    .split('\n')
    .filter(code)
    .map((line) => line.replace(/\s#\s.*$/, ''))
    .join('\n')
    .replace(/'[^']*'/g, "''");

it('uses only shell variables that the same block or an earlier one assigns', () => {
  const assigned = new Set<string>();
  for (const block of shell) {
    const text = shellText(block);
    for (const m of text.matchAll(/(?:^|[\s;(])(?:export\s+)?([A-Za-z_]\w*)\+?=/g)) assigned.add(m[1] as string);
    for (const m of text.matchAll(/\blocal\s+([A-Za-z_][\w ]*)/g)) for (const name of (m[1] ?? '').split(/\s+/)) if (name) assigned.add(name);
    for (const m of text.matchAll(/\$\{?([A-Za-z_]\w*)(:[-+])?/g)) {
      if (m[2]) continue; // ${NAME:-default} and ${NAME:+word} are defined whether or not NAME is set
      expect(assigned, `${m[0]} is used but never assigned before or in its block:\n${block}`).toContain(m[1]);
    }
  }
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
    `Entries after ${first('Targets indexed')} contribute no index entry`,
  ];
  for (const phrase of quoted) expect(guide.replace(/\s+/g, ' '), phrase).toContain(phrase);
});
