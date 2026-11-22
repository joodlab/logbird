// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
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

type Node = { type: string; loc?: { start: { line: number } } | null; [key: string]: unknown };
const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

/** The syntax tree of a source file (TypeScript, with JSX for .tsx), so comments, strings and JSX text are never code. */
function syntaxTree(src: string, jsx: boolean): Node {
  return parse(src, { sourceType: 'module', errorRecovery: true, plugins: jsx ? ['typescript', 'jsx'] : ['typescript'] }) as unknown as Node;
}

/** Every node of the tree, depth first. */
function* walk(node: Node): Generator<Node> {
  yield node;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'extra' || key.endsWith('Comments')) continue;
    for (const child of Array.isArray(value) ? value : [value]) if (isNode(child)) yield* walk(child);
  }
}

/** The expression under TypeScript wrappers and parentheses: `x as T`, `x satisfies T`, `x!`, `<T>x`, `(x)`. */
function unwrap(node: unknown): Node | undefined {
  let n = isNode(node) ? node : undefined;
  while (n && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression'].includes(n.type)) {
    n = isNode(n.expression) ? n.expression : undefined;
  }
  return n;
}
const nameOf = (node: unknown): string | undefined => {
  const n = unwrap(node);
  return n?.type === 'Identifier' ? (n.name as string) : undefined;
};
/** A property's key when it is written out (`data`, `'data'`, `['data']`), not computed from a variable. */
const keyOf = (key: unknown, computed: unknown): string | undefined => {
  if (!isNode(key)) return undefined;
  if (key.type === 'StringLiteral') return key.value as string;
  return !computed && key.type === 'Identifier' ? (key.name as string) : undefined;
};
const isQueryHook = (node: Node | undefined): node is Node => {
  if (node?.type !== 'CallExpression') return false;
  const callee = unwrap(node.callee);
  const name = callee?.type === 'MemberExpression' ? nameOf(callee.property) : nameOf(callee);
  return name === 'useQuery' || name === 'useInfiniteQuery';
};

/**
 * Direct `.data` reads of a placeholder-enabled query's result. Each `useQuery(...)` (or `useInfiniteQuery`) whose
 * options come from a placeholder-enabled factory (directly, spread into an object, or through options variables), or
 * that set `placeholderData` themselves, may be read only through `current(x)` or `shownDimmed(x)`: any `x.data` (or
 * destructured `data`) is a finding. No heuristics about branches: the helpers are the only way in. The guard walks
 * the syntax tree, so comments, strings, JSX text, regex literals and line breaks neither hide nor invent a read.
 */
export function unguardedReads(src: string, queries: readonly string[], jsx = true): string[] {
  const tree = syntaxTree(src, jsx);
  const lines = src.split('\n');
  const at = (node: Node) => {
    const line = node.loc?.start.line ?? 0;
    return `line ${line}: ${lines[line - 1]?.trim()}`;
  };
  const factories = new Set(queries);
  const optionVariables = new Set<string>();
  // Options: a whole factory call (not `factory(...).queryKey`), a known options variable, or an object literal that
  // spreads one of those or sets `placeholderData` itself (`placeholderData: x` or the shorthand; not a value so named).
  const isOptions = (node: unknown): boolean => {
    const n = unwrap(node);
    if (!n) return false;
    if (n.type === 'CallExpression') return factories.has(nameOf(n.callee) ?? '');
    if (n.type === 'Identifier') return optionVariables.has(n.name as string);
    if (n.type === 'ConditionalExpression') return isOptions(n.consequent) || isOptions(n.alternate);
    if (n.type !== 'ObjectExpression') return false;
    return (n.properties as Node[]).some((p) =>
      p.type === 'SpreadElement' ? isOptions(p.argument) : keyOf(p.key, p.computed) === 'placeholderData',
    );
  };
  const nodes = [...walk(tree)];
  const declarators = nodes.filter((n) => n.type === 'VariableDeclarator');
  // Options variables, in any order and through any number of steps (`base = factory()`, `opts = { ...base }`).
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of declarators) {
      const name = nameOf(d.id);
      if (name && !optionVariables.has(name) && !isQueryHook(unwrap(d.init)) && isOptions(d.init)) {
        optionVariables.add(name);
        grew = true;
      }
    }
  }
  const problems = new Set<string>();
  const results = new Set<string>();
  const destructuresData = (pattern: unknown) =>
    isNode(pattern) &&
    pattern.type === 'ObjectPattern' &&
    (pattern.properties as Node[]).some((p) => p.type === 'ObjectProperty' && keyOf(p.key, p.computed) === 'data');
  for (const d of declarators) {
    const init = unwrap(d.init);
    if (!isQueryHook(init) || !isOptions((init.arguments as unknown[])[0])) continue;
    const name = nameOf(d.id);
    if (name) results.add(name);
    else if (destructuresData(d.id)) problems.add(`destructured data on ${at(d)}`);
  }
  for (const n of nodes) {
    if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') {
      const result = nameOf(n.object);
      if (result && results.has(result) && keyOf(n.property, n.computed) === 'data') problems.add(`${result}.data on ${at(n)}`);
    } else if (n.type === 'VariableDeclarator' && results.has(nameOf(n.init) ?? '') && destructuresData(n.id)) {
      problems.add(`destructured data on ${at(n)}`);
    }
  }
  return [...problems];
}

/** Whether a file uses a placeholder-enabled factory or sets `placeholderData` on any options object. */
function usesPlaceholders(src: string, queries: readonly string[], jsx: boolean): boolean {
  for (const n of walk(syntaxTree(src, jsx))) {
    if (n.type === 'CallExpression' && queries.includes(nameOf(n.callee) ?? '')) return true;
    if ((n.type === 'ObjectProperty' || n.type === 'ObjectMethod') && keyOf(n.key, n.computed) === 'placeholderData') return true;
  }
  return false;
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
      const src = ['const fields = useQuery(fieldsQuery(p, r));', before, 'render(fields.data);', before.endsWith('{') ? '}' : ''].join('\n');
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
  it('sees reads next to JSX text, URLs, regex literals and non-null division', () => {
    for (const line of [
      "return <p>Today's fields: {result.data?.length}</p>;",
      'return <p>See https://example.org for {result.data?.length} fields.</p>;',
      "return /'/.test(label) && result.data?.length;",
      'return count! / result.data.total;',
    ]) {
      const src = ['const result = useQuery(fieldsQuery(p, r));', line].join('\n');
      expect(unguardedReads(src, ['fieldsQuery']), line).toEqual([`result.data on line 2: ${line}`]);
    }
  });
  it('does not take JSX text that spells a read for one', () => {
    const src = ['const result = useQuery(fieldsQuery(p, r));', 'return <code>result.data</code>;'].join('\n');
    expect(unguardedReads(src, ['fieldsQuery'])).toEqual([]);
  });
  it('follows a spread of an options variable, and options objects that set placeholderData', () => {
    const spread = [
      'const base = fieldsQuery(p, r);',
      'const options = { ...base, enabled };',
      'const fields = useQuery(options);',
      'return fields.data;',
    ];
    expect(unguardedReads(spread.join('\n'), ['fieldsQuery'])).toHaveLength(1);
    const extracted = [
      'const options = {',
      "  queryKey: ['preview'],",
      '  queryFn: loadPreview,',
      '  placeholderData: keepPreviousData,',
      '};',
      'const preview = useQuery(options);',
      'return preview.data;',
    ].join('\n');
    expect(unguardedReads(extracted, [])).toHaveLength(1);
    // The file filter selects it too: placeholderData before the query call.
    expect(usesPlaceholders(extracted, [], false)).toBe(true);
  });
  it('flags data destructured from a result later', () => {
    const src = ['const fields = useQuery(fieldsQuery(p, r));', 'const { data, isFetching } = fields;'].join('\n');
    expect(unguardedReads(src, ['fieldsQuery'])).toEqual(['destructured data on line 2: const { data, isFetching } = fields;']);
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
  const files = sourceFiles(root).filter((file) => usesPlaceholders(readFileSync(file, 'utf8'), queries, file.endsWith('.tsx')));
  it.each(files.map((f) => [relative(root, f).replaceAll('\\', '/'), f]))('%s', (_name, file) => {
    expect(unguardedReads(readFileSync(file, 'utf8'), queries, file.endsWith('.tsx'))).toEqual([]);
  });
});
