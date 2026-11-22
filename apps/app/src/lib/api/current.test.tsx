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
 * Reads of a placeholder-enabled query's `.data` that do not go through `current()`: each `const x = useQuery(...)` (or
 * `useInfiniteQuery`) built from such a query, directly or through an options variable, may read `x.data` only on a
 * line that branches on `x.isPlaceholderData` (`x.isPlaceholderData ? … : x.data`, `!x.isPlaceholderData && x.data`, or an
 * `if` on the line before), or
 * right after an explicit `// placeholder: shown dimmed` marker, which is how a component shows an old answer on purpose.
 */
export function unguardedReads(src: string, queries: readonly string[]): string[] {
  const names = queries.join('|');
  const optionVars = [...src.matchAll(new RegExp(String.raw`(?:const|let)\s+(\w+)\s*=\s*(?:\{\s*\.\.\.)?(?:${names})\(`, 'g'))].map((m) => m[1]);
  const sources = [names, ...optionVars].join('|');
  const results = [
    ...src.matchAll(new RegExp(String.raw`(?:const|let)\s+(\w+)\s*=\s*use(?:Infinite)?Query\(\s*(?:\{\s*\.\.\.)?(?:${sources})\b`, 'g')),
  ].map((m) => m[1]);
  const lines = src.split('\n');
  const problems: string[] = [];
  for (const r of results) {
    const reads = new RegExp(String.raw`\b${r}\.data\b`);
    // A condition on the flag in the same expression: `flag ?`, `!flag`, `flag &&` or `flag ||`. Merely mentioning it is not.
    const branch = new RegExp(String.raw`(!\s*${r}\.isPlaceholderData\b|\b${r}\.isPlaceholderData\s*(\?|&&|\|\|))`);
    const marker = /\/\/ placeholder: shown dimmed/;
    lines.forEach((line, i) => {
      // The branch can open on the line before (`if (… && !x.isPlaceholderData) {`).
      const prev = lines[i - 1] ?? '';
      if (reads.test(line) && !branch.test(line) && !branch.test(prev) && !marker.test(prev))
        problems.push(`${r}.data on line ${i + 1}: ${line.trim()}`);
    });
  }
  return problems;
}

describe('the guard catches unguarded reads', () => {
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
  it('does not accept a mere mention of the flag before an unconditional read', () => {
    const src = ['const fields = useQuery(fieldsQuery(p, r));', 'console.log(fields.isPlaceholderData);', 'render(fields.data);'].join('\n');
    expect(unguardedReads(src, ['fieldsQuery'])).toHaveLength(1);
  });
  it('accepts an explicit placeholder branch or the dimmed marker', () => {
    const marked = [
      'const list = useInfiniteQuery(entityListQuery(p, k));',
      '// placeholder: shown dimmed (aria-busy)',
      'const rows = list.data?.pages;',
    ].join('\n');
    expect(unguardedReads(marked, ['entityListQuery'])).toEqual([]);
    const src = [
      'const facet = useQuery(facetQuery(p, f, r, q, 20));',
      'const values = facet.isPlaceholderData ? [] : (facet.data?.values ?? []);',
    ].join('\n');
    expect(unguardedReads(src, ['facetQuery'])).toEqual([]);
  });
});

describe('every consumer of a placeholder-enabled query reads it through current() or an explicit placeholder branch', () => {
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
