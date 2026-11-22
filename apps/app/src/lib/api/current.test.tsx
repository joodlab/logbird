// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { awaiting, current } from './current';
import { keepPreviousInProject } from './queries';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** React Query notifies observers in a batch on the next tick. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('placeholder data is never current', () => {
  it('reads data only when it answers the current key', () => {
    expect(current({ data: 'previous', isPlaceholderData: true })).toBeUndefined();
    expect(current({ data: 'mine', isPlaceholderData: false })).toBe('mine');
    expect(awaiting({ isPending: false, isPlaceholderData: true })).toBe(true);
    expect(awaiting({ isPending: true, isPlaceholderData: false })).toBe(true);
    expect(awaiting({ isPending: false, isPlaceholderData: false })).toBe(false);
  });

  it('a project query switching range shows nothing from the previous range until its own answer arrives', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const answers = new Map<string, (v: string) => void>();
    let switchRange: ((r: string) => void) | undefined;
    function Widget() {
      const [range, setRange] = useState('24h');
      switchRange = setRange;
      const q = useQuery({
        queryKey: ['projects', 'p1', 'overview', range],
        queryFn: () => new Promise<string>((resolve) => answers.set(range, resolve)),
        placeholderData: keepPreviousInProject('p1'),
      });
      return <output>{awaiting(q) ? 'loading' : `${current(q)} · ${range}`}</output>;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Widget />
        </QueryClientProvider>,
      );
      await settle();
    });
    await act(async () => {
      answers.get('24h')?.('1,204 events');
      await settle();
    });
    expect(host.textContent).toBe('1,204 events · 24h');
    await act(async () => {
      switchRange?.('7d');
      await settle();
    });
    // The 24h answer is still in the query (placeholder), but it must not render under "7d".
    expect(host.textContent).toBe('loading');
    await act(async () => {
      answers.get('7d')?.('8,410 events');
      await settle();
    });
    expect(host.textContent).toBe('8,410 events · 7d');
    act(() => root.unmount());
  });
});

/** Query options in lib/api/queries.ts that keep the previous answer as a placeholder. */
function placeholderQueries(): string[] {
  const src = readFileSync(join(import.meta.dirname, 'queries.ts'), 'utf8');
  const names: string[] = [];
  for (const block of src.split(/\nexport (?:const|function) /).slice(1)) {
    const name = /^([A-Za-z]+)/.exec(block)?.[1];
    if (name?.endsWith('Query') && /placeholderData:/.test(block)) names.push(name);
  }
  return names;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

/**
 * Direct `.data` reads of a placeholder-enabled query's result. Each `const x = useQuery(...)` (or `useInfiniteQuery`)
 * built from such a query (directly or through an options variable), or given `placeholderData` at the call site, may
 * be read only through `current(x)` or `shownDimmed(x)`: any `x.data` is a finding. No heuristics about branches: the
 * helpers are the only way in.
 */
/** The text of a declaration's initializer: from `start` to the first `;` or line break outside brackets. */
function initializerAt(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (depth <= 0 && (c === ';' || c === '\n')) return src.slice(start, i);
  }
  return src.slice(start);
}

/**
 * The source with comments, string contents, template text and regex literals blanked to spaces (line breaks and every
 * offset kept), so brackets, `)` and words inside them never count as code. Template `${…}` expressions stay code.
 */
export function scrub(src: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  const templates: number[] = []; // brace depth at each open `${`
  let out = '';
  let depth = 0;
  let prev = ''; // last significant character, to tell a regex literal from a division
  let i = 0;
  const skipQuoted = (from: number, isEnd: (j: number) => boolean) => {
    let j = from;
    while (j < src.length && !isEnd(j)) j += src[j] === '\\' ? 2 : 1;
    return Math.min(j, src.length);
  };
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === '/' && (next === '/' || next === '*')) {
      const close = next === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : next === '/' ? close : close + 2;
      out += blank(src.slice(i, end));
      i = end;
    } else if (c === "'" || c === '"') {
      const end = skipQuoted(i + 1, (j) => src[j] === c || src[j] === '\n');
      out += c + blank(src.slice(i + 1, end)) + (src[end] ?? '');
      i = end + 1;
      prev = c;
    } else if (c === '`' || (c === '}' && templates.at(-1) === depth)) {
      if (c === '}') templates.pop();
      const end = skipQuoted(i + 1, (j) => src[j] === '`' || (src[j] === '$' && src[j + 1] === '{'));
      out += c + blank(src.slice(i + 1, end));
      if (src[end] === '$') {
        out += '${';
        templates.push(depth);
        i = end + 2;
        prev = '{';
      } else {
        out += src[end] ?? '';
        i = end + 1;
        prev = '`';
      }
    } else if (c === '/' && (prev === '' || '(,=:[!&|?{};'.includes(prev))) {
      let inClass = false;
      const end = skipQuoted(i + 1, (j) => {
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        return src[j] === '\n' || (src[j] === '/' && !inClass);
      });
      out += `/${blank(src.slice(i + 1, end))}${src[end] ?? ''}`;
      i = end + 1;
      prev = '/';
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      out += c;
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out;
}

/** A `placeholderData` property in an options object (`placeholderData: …` or the shorthand), not a value named so. */
const SETS_PLACEHOLDER = /[{,]\s*placeholderData\s*[:,}]/;

/** Index just past the `)` that closes the call opening at `open` (an index of `(`), or -1. */
function callEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i + 1;
  }
  return -1;
}
/** `q(...)` and nothing after it (not `q(...).queryKey`). */
function isWholeCall(init: string, q: string): boolean {
  const open = new RegExp(String.raw`^${q}\s*\(`).exec(init);
  if (!open) return false;
  const end = callEnd(init, open[0].length - 1);
  return end > 0 && init.slice(end).trim() === '';
}
/** An object literal with `...q(...)` as one of its own (top-level) properties: the spread call ends at `,` or `}`. */
function spreadsCall(init: string, q: string): boolean {
  if (!init.startsWith('{')) return false;
  let depth = 0;
  for (let i = 0; i < init.length; i++) {
    const c = init[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (depth === 1 && c === '.') {
      // `...q(…)`, with any spacing or line breaks after the dots and before the parenthesis.
      const spread = new RegExp(String.raw`^\.\.\.\s*${q}\s*\(`).exec(init.slice(i));
      if (!spread) continue;
      const end = callEnd(init, i + spread[0].length - 1);
      if (end > 0 && /^\s*[,}]/.test(init.slice(end))) return true;
    }
  }
  return false;
}

export function unguardedReads(original: string, queries: readonly string[]): string[] {
  // Match against code only; report the original lines (scrub keeps every offset).
  const src = scrub(original);
  const lines = original.split('\n');
  const declarations = [...src.matchAll(/(?:const|let)\s+(\{[^}]*\}|\w+)\s*=\s*/g)].map((m) => ({
    target: m[1] ?? '',
    init: initializerAt(src, (m.index ?? 0) + m[0].length),
  }));
  // Options variables: the factory call itself (`fieldsQuery(...)`), or an object literal spreading one
  // (`{ enabled, ...fieldsQuery(...) }`). A value that merely mentions a factory (`!!getQueryData(fieldsQuery(...).queryKey)`)
  // is not options.
  const sources = [...queries];
  const isOptions = (init: string) => sources.some((q) => isWholeCall(init.trim(), q) || spreadsCall(init.trim(), q));
  for (const d of declarations) if (/^\w+$/.test(d.target) && !/^use(?:Infinite)?Query\(/.test(d.init) && isOptions(d.init)) sources.push(d.target);
  // A result is placeholder-enabled when its options come from such a query, or when the call sets `placeholderData` itself.
  const built = (init: string) =>
    /^use(?:Infinite)?Query\(/.test(init) && (SETS_PLACEHOLDER.test(init) || sources.some((q) => new RegExp(String.raw`\b${q}\b`).test(init)));
  const problems: string[] = [];
  const results: string[] = [];
  for (const d of declarations) {
    if (!built(d.init)) continue;
    // Destructuring `data` out of the result reads it directly.
    if (d.target.startsWith('{')) {
      if (/\bdata\b/.test(d.target)) problems.push(`destructured data: ${d.target} = ${d.init.split('\n')[0]}`);
    } else results.push(d.target);
  }
  src.split('\n').forEach((line, i) => {
    for (const r of results) if (new RegExp(String.raw`\b${r}\.data\b`).test(line)) problems.push(`${r}.data on line ${i + 1}: ${lines[i]?.trim()}`);
  });
  return problems;
}

describe('the guard catches direct reads', () => {
  it('flags a second, unguarded query in a file that already uses current()', () => {
    const src = [
      "import { current } from '@/lib/api/current';",
      'const self = useQuery(facetQuery(projectId, "actor", range, q, 1));',
      'const series = useQuery({ ...histogramQuery(projectId, range, q), retry });',
      'const name = current(self)?.values[0]?.label;',
      'const chart = series.data;',
    ].join('\n');
    expect(unguardedReads(src, ['facetQuery', 'histogramQuery'])).toEqual(['series.data on line 5: const chart = series.data;']);
  });
  it('follows options built into a variable first', () => {
    const src = ['const options = fieldsQuery(projectId, range);', 'const fields = useQuery(options);', 'const rows = fields.data?.data ?? [];'].join(
      '\n',
    );
    expect(unguardedReads(src, ['fieldsQuery'])).toHaveLength(1);
  });
  it('flags a read whatever surrounds it: a mention, a branch either way, a comment', () => {
    for (const before of [
      'console.log(!fields.isPlaceholderData);',
      'if (fields.isPlaceholderData) {',
      'if (!fields.isPlaceholderData) {',
      '// placeholder: shown dimmed',
    ]) {
      const src = ['const fields = useQuery(fieldsQuery(p, r));', before, 'render(fields.data);'].join('\n');
      expect(unguardedReads(src, ['fieldsQuery']), before).toHaveLength(1);
    }
  });
  it('finds the query anywhere in the options, and destructured data', () => {
    const later = ['const fields = useQuery({ enabled: open, ...fieldsQuery(projectId, range) });', 'return fields.data?.data;'].join('\n');
    expect(unguardedReads(later, ['fieldsQuery'])).toHaveLength(1);
    const multiline = ['const fields = useQuery({', '  enabled: open,', '  ...fieldsQuery(projectId, range),', '});', 'return fields.data;'].join(
      '\n',
    );
    expect(unguardedReads(multiline, ['fieldsQuery'])).toHaveLength(1);
    const options = [
      'const opts = { enabled: open, ...fieldsQuery(projectId, range) };',
      'const fields = useQuery(opts);',
      'return fields.data;',
    ].join('\n');
    expect(unguardedReads(options, ['fieldsQuery'])).toHaveLength(1);
    const destructured = 'const { data } = useQuery({ staleTime: 1, ...fieldsQuery(projectId, range) });';
    expect(unguardedReads(destructured, ['fieldsQuery'])).toHaveLength(1);
  });
  it('treats a call-site placeholderData as placeholder-enabled (the retention preview pattern)', () => {
    const src = [
      'const preview = useQuery({ ...retentionQuery(id, days), enabled, placeholderData: keepPreviousData });',
      'return preview.data?.count;',
    ].join('\n');
    expect(unguardedReads(src, ['fieldsQuery'])).toHaveLength(1);
  });
  it('does not take a value that merely mentions a factory for options', () => {
    const src = [
      'const enabled = !!client.getQueryData(fieldsQuery(p, r).queryKey);',
      'const project = useQuery({ ...projectQuery(p), enabled });',
      'return project.data?.name;',
    ].join('\n');
    expect(unguardedReads(src, ['fieldsQuery'])).toEqual([]);
  });
  it("does not take a factory's query key for options", () => {
    const src = [
      'const key = fieldsQuery(p, r).queryKey;',
      'const project = useQuery({ ...projectQuery(p), enabled: Boolean(key.length) });',
      'return project.data?.name;',
    ].join('\n');
    expect(unguardedReads(src, ['fieldsQuery'])).toEqual([]);
  });
  it('treats a shorthand call-site placeholderData as placeholder-enabled', () => {
    const src = [
      'const placeholderData = keepPreviousData;',
      'const preview = useQuery({ ...retentionQuery(id, days), placeholderData });',
      'return preview.data?.count;',
    ].join('\n');
    expect(unguardedReads(src, [])).toHaveLength(1);
  });
  it('sees a spread through a comment or a line break after the dots', () => {
    const commented = [
      'const opts = { ...fieldsQuery(p, r) /* keep its cache policy */, enabled };',
      'const result = useQuery(opts);',
      'return result.data;',
    ].join('\n');
    expect(unguardedReads(commented, ['fieldsQuery'])).toHaveLength(1);
    const broken = [
      'const opts = {',
      '  ...',
      '    fieldsQuery(p, r),',
      '  enabled,',
      '};',
      'const result = useQuery(opts);',
      'return result.data;',
    ].join('\n');
    expect(unguardedReads(broken, ['fieldsQuery'])).toHaveLength(1);
  });
  it('ignores a parenthesis inside a quoted argument', () => {
    const src = ["const opts = facetQuery(p, 'a)', range, q, 1);", 'const result = useQuery(opts);', 'return result.data;'].join('\n');
    expect(unguardedReads(src, ['facetQuery'])).toHaveLength(1);
  });
  it('does not take a value named placeholderData for the property', () => {
    const src = ['const project = useQuery({ ...projectQuery(p), initialData: placeholderData });', 'return project.data?.name;'].join('\n');
    expect(unguardedReads(src, [])).toEqual([]);
  });
  // Source text under test holds template literals; `$` + `{` keeps the linter from reading them as this file's own.
  const open = '${';
  it('reads code only: strings and comments never count, template expressions do', () => {
    const title = `const title = \`fields: ${open}list.data?.length}\`;`;
    const src = [
      '// const old = useQuery(fieldsQuery(p, r)); old.data',
      'const list = useQuery(fieldsQuery(p, r));',
      'const label = "list.data";',
      title,
    ].join('\n');
    expect(unguardedReads(src, ['fieldsQuery'])).toEqual([`list.data on line 4: ${title}`]);
  });
  it('scrubs without moving anything', () => {
    const src = `const a = 'x)'; // y(\nconst r = /[/]'/; const t = \`a${open}b('}')}c\`;`;
    const out = scrub(src);
    expect(out).toHaveLength(src.length);
    expect(out.split('\n')).toHaveLength(2);
    expect(out).not.toMatch(/x\)|y\(/);
    expect(out).toContain("b(' ')");
  });
  it('accepts reads through the helpers', () => {
    const src = [
      'const list = useInfiniteQuery(entityListQuery(p, k));',
      'const rows = shownDimmed(list)?.pages;',
      'const total = current(list)?.pages.length;',
    ].join('\n');
    expect(unguardedReads(src, ['entityListQuery'])).toEqual([]);
  });
});

describe('every consumer of a placeholder-enabled query reads it through current() or shownDimmed()', () => {
  const queries = placeholderQueries();
  it('finds the placeholder-enabled queries', () => {
    expect(queries).toEqual(
      expect.arrayContaining(['overviewQuery', 'eventsInfiniteQuery', 'histogramQuery', 'facetQuery', 'entityListQuery', 'fieldsQuery']),
    );
  });
  const root = join(import.meta.dirname, '..', '..');
  // Every file using a placeholder-enabled factory, or setting `placeholderData` on a query call itself.
  const files = sourceFiles(root).filter((file) => {
    const src = scrub(readFileSync(file, 'utf8'));
    return (
      queries.some((q) => new RegExp(String.raw`\b${q}\s*\(`).test(src)) || /use(?:Infinite)?Query\([\s\S]*?[{,]\s*placeholderData\s*[:,}]/.test(src)
    );
  });
  it.each(files.map((f) => [relative(root, f).replaceAll('\\', '/'), f]))('%s', (_name, file) => {
    expect(unguardedReads(readFileSync(file, 'utf8'), queries)).toEqual([]);
  });
});
