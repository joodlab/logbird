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
 * built from such a query, directly or through an options variable, may be read only through `current(x)` or
 * `shownDimmed(x)`: any `x.data` is a finding. No heuristics about branches: the helpers are the only way in.
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

export function unguardedReads(src: string, queries: readonly string[]): string[] {
  const declarations = [...src.matchAll(/(?:const|let)\s+(\{[^}]*\}|\w+)\s*=\s*/g)].map((m) => ({
    target: m[1] ?? '',
    init: initializerAt(src, (m.index ?? 0) + m[0].length),
  }));
  // Options that carry a placeholder-enabled query anywhere in their initializer (`{ enabled, ...fieldsQuery(...) }`).
  const sources = [...queries];
  for (const d of declarations)
    if (/^\w+$/.test(d.target) && !/^use(?:Infinite)?Query\(/.test(d.init) && sources.some((q) => new RegExp(String.raw`\b${q}\b`).test(d.init)))
      sources.push(d.target);
  const built = (init: string) => /^use(?:Infinite)?Query\(/.test(init) && sources.some((q) => new RegExp(String.raw`\b${q}\b`).test(init));
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
    for (const r of results) if (new RegExp(String.raw`\b${r}\.data\b`).test(line)) problems.push(`${r}.data on line ${i + 1}: ${line.trim()}`);
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
  const files = sourceFiles(root).filter((file) => queries.some((q) => readFileSync(file, 'utf8').includes(`${q}(`)));
  it.each(files.map((f) => [relative(root, f).replaceAll('\\', '/'), f]))('%s', (_name, file) => {
    expect(unguardedReads(readFileSync(file, 'utf8'), queries)).toEqual([]);
  });
});
