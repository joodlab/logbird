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
    let switchRange: (r: string) => void = () => {};
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
      switchRange('7d');
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

describe('every consumer of a placeholder-enabled query reads it through current()/awaiting()', () => {
  const queries = placeholderQueries();
  it('finds the placeholder-enabled queries', () => {
    expect(queries).toEqual(
      expect.arrayContaining(['overviewQuery', 'eventsInfiniteQuery', 'histogramQuery', 'facetQuery', 'entityListQuery', 'fieldsQuery']),
    );
  });

  const root = join(import.meta.dirname, '..', '..');
  const consumers = sourceFiles(root).filter((file) => {
    const src = readFileSync(file, 'utf8');
    return queries.some((q) => new RegExp(`use(?:Infinite)?Query\\(\\s*(?:\\{\\s*\\.\\.\\.)?${q}\\(`).test(src));
  });

  /** Consumers that may keep the previous answer as it is, and why. */
  const allowed: Record<string, string> = {
    // Field names from the previous range are still valid autocomplete suggestions; nothing is counted or labelled.
    'components/query-input/use-completions.ts': 'autocomplete field names',
  };

  it.each(consumers.map((f) => [relative(root, f).replaceAll('\\', '/'), f]))('%s', (name, file) => {
    if (allowed[name]) return;
    const src = readFileSync(file, 'utf8');
    // Either the shared helpers, or an explicit `isPlaceholderData` branch that shows the old answer dimmed and busy.
    expect(/from '@\/lib\/api\/current'/.test(src) || /isPlaceholderData/.test(src)).toBe(true);
  });
});
