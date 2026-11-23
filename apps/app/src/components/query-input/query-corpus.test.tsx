// @vitest-environment happy-dom
/**
 * The query bar against a whole corpus of valid queries, not the cases found so far (#220 follow-up, a maintainer's
 * condition). The corpus is every literal in the server parser's own tests and in the console's query tests (each
 * review's cases) that the parser accepts, with spaces around some. With the completion panel live against a fixture:
 * 1. typed character by character and run with plain Enter, the submitted text is the typed text, character for
 *    character;
 * 2. at every term boundary of the server's parse, each of the first rows offered, accepted by click, changes the text
 *    only inside that row's own span, leaves a query that parses (or does once a word is typed at the caret), and
 *    leaves every other term unchanged in the server's parse, by an oracle written here on the parser; a row that is
 *    refused is checked to have been unsafe in every form.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseQueryExpression, type QueryAtom } from '@logbird/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.mock(import('@tanstack/react-router'), async (original) => ({ ...(await original()), useNavigate: () => vi.fn() }));

const { fixture } = vi.hoisted(() => {
  const values: Record<string, string[]> = {
    action: ['booked', 'booking.created', 'abcd.logged', 'book:two tenant', 'test-action'],
    outcome: ['success', 'failure', 'denied'],
    tenant: ['west', 'biz_7', 'qa-clinic-1'],
    actor: ['qa-user-1', 'amy'],
    impersonator: ['amy', 'bea'],
    record: ['page:7', 'order\\:archived:A1'],
    target: ['7', 'A1'],
    'attr.ticket status': ['open', 'closed'],
    'attr.plan': ['pro'],
  };
  return {
    fixture: {
      values,
      fields: [
        { key: 'attr.ticket status', kind: 'attribute', coverage: 0.5, distinctApprox: 2, samples: ['open'], lastSeen: null },
        { key: 'attr.plan', kind: 'attribute', coverage: 0.4, distinctApprox: 1, samples: ['pro'], lastSeen: null },
        { key: 'attr._exists_', kind: 'attribute', coverage: 0.1, distinctApprox: 1, samples: ['x'], lastSeen: null },
      ],
    },
  };
});

vi.mock('@/lib/api/client', () => ({
  api: {
    fields: vi.fn(async () => ({ data: fixture.fields, avgConformance: 1 })),
    suggest: vi.fn(async (_p: string, { field, prefix }: { field: string; prefix?: string }) => ({
      field,
      values: (fixture.values[field] ?? [])
        .filter((v) => !prefix || v.toLowerCase().includes(prefix.toLowerCase()))
        .map((value) => ({ value, label: value, count: 1 })),
      complete: true,
    })),
    views: { list: vi.fn(async () => []) },
    entities: { list: vi.fn(async () => ({ data: [], nextCursor: null })) },
  },
}));

import { QueryInput } from './query-input';

/* ---------------- the corpus ---------------- */

const ROOT = resolve(import.meta.dirname, '../../../../..');
const SOURCES = [
  'packages/clickhouse/src/query.test.ts',
  'packages/clickhouse/src/query-v2.test.ts',
  'apps/app/src/lib/query-language.test.ts',
  'apps/app/src/lib/query-editing.test.ts',
  'apps/app/src/lib/sql-language.test.ts',
  'apps/app/src/lib/activity-search.test.ts',
  'apps/app/src/lib/query-lint.test.ts',
];
const unescapeLiteral = (s: string) => s.replace(/\\(.)/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
const parses = (q: string) => {
  try {
    parseQueryExpression(q);
    return true;
  } catch {
    return false;
  }
};
const literals = [
  ...new Set(
    SOURCES.flatMap((file) => {
      const text = readFileSync(resolve(ROOT, file), 'utf8');
      return [...text.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)].map((m) => unescapeLiteral(m[1] ?? m[2] ?? ''));
    }),
  ),
];
// Every literal the parser accepts (free text, KQL-looking text and bare prefixes included), without control characters
// (a textarea has its own rules for those), plus each query with spaces around it, which Enter must keep too.
const valid = literals.filter((q) => q.trim() && q.length <= 160 && ![...q].some((c) => c.charCodeAt(0) < 0x20) && parses(q)).sort();
const corpus = [
  ...valid,
  ...valid
    .filter((q) => /[:(]/.test(q))
    .slice(0, 40)
    .map((q) => `  ${q} `),
  'action=booked',
  'act',
];

/* ---------------- an oracle of its own, from the server's parser ---------------- */

/**
 * Every term of `q` outside `[from, to)` as the server parses it: field or word, value, polarity and, when `structural`,
 * the OR branches it sits in. Written here independently of the console's comparator.
 */
function outsideTerms(q: string, from: number, to: number, structural: boolean): string | null {
  let expression: ReturnType<typeof parseQueryExpression>;
  try {
    expression = parseQueryExpression(q);
  } catch {
    return null;
  }
  const out: string[] = [];
  const omit = (k: string, v: unknown) => (['start', 'end', 'valueStart', 'key'].includes(k) ? undefined : v);
  const walk = (node: QueryAtom, negated: boolean, path: string): void => {
    if (node.kind === 'not') {
      walk(node.operand, !negated, path);
      return;
    }
    if (node.kind === 'group') {
      node.expression.forEach((branch, i) => {
        for (const p of branch) walk(p.atom, negated, `${path}.${i}`);
      });
      return;
    }
    if (node.start < to && node.end > from) return;
    const value = node.kind === 'field' ? [node.field, node.value] : [node.token.kind, node.token.value];
    out.push(JSON.stringify([structural ? path : '', node.kind, value, negated], omit));
  };
  expression.forEach((branch, i) => {
    for (const p of branch) walk(p.atom, false, `${i}`);
  });
  return out.join('\n');
}

/* ---------------- the bar ---------------- */

let root: Root;
let host: HTMLDivElement;
const submit = vi.fn();
const setNative = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
const textarea = () => host.querySelector('textarea') as HTMLTextAreaElement;
const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(260);
  });
};
// React ignores an input event whose value did not change, so the text is cleared first: a new caret in the same
// text reaches the bar too.
const setValue = (value: string, caret = value.length) =>
  act(() => {
    const t = textarea();
    setNative?.call(t, t.value === value ? `${value}#` : value);
    t.dispatchEvent(new Event('input', { bubbles: true }));
    setNative?.call(t, value);
    t.setSelectionRange(caret, caret);
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });
const key = (k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: k, ...init }));
  });
const options = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')].filter((o) => o.getAttribute('aria-disabled') !== 'true');

beforeAll(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <QueryInput lang="query" onSubmit={submit} projectId="qa-corpus" range="24h" value="" />
      </QueryClientProvider>,
    ),
  );
});

afterAll(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('has a real corpus', () => {
  expect(valid.length).toBeGreaterThan(200);
});

/** Term boundaries of the server's parse: where each term starts and ends, where a field's value starts, and the ends. */
function boundaries(q: string): number[] {
  const at = new Set<number>([0, q.length]);
  const visit = (node: QueryAtom) => {
    if (node.kind === 'not') visit(node.operand);
    else if (node.kind === 'group') for (const b of node.expression) for (const p of b) visit(p.atom);
    else {
      at.add(node.start);
      at.add(node.end);
      if (node.kind === 'field') at.add(node.valueStart);
    }
  };
  for (const b of parseQueryExpression(q)) for (const p of b) visit(p.atom);
  return [...at].sort((a, b) => a - b);
}

/**
 * Whether accepting a row (`insert` over `[from, to)` in `q`) gave `result` within the rules: the text changed only
 * inside the row's span, the query parses (or does once a word is typed at the caret), and every term outside the span
 * is unchanged in the server's parse (structure too, unless the row is an operator or a snippet the reader chose).
 */
function withinRules(q: string, from: number, to: number, result: string, caret: number, structural: boolean): boolean {
  if (!result.startsWith(q.slice(0, from)) || !result.endsWith(q.slice(to))) return false;
  // As the reader will finish it: a word typed at the caret (`action:`, `OR`, `()`), or both bounds of a range template.
  const finished = [result, `${result.slice(0, caret)} x${result.slice(caret)}`, result.replace(/([[{])\s*TO\s*([\]}])/, '$1x TO x$2')].find(parses);
  if (finished === undefined) return false;
  const end = from + (finished.length - (q.length - (to - from)));
  return outsideTerms(finished, from, end, structural) === outsideTerms(q, from, to, structural);
}

it('a row accepted at any term boundary changes only its own span, and the query still parses', async () => {
  const broken: string[] = [];
  let accepted = 0;
  for (const q of ['', '  ', ...valid]) {
    for (const b of boundaries(q)) {
      for (let row = 0; row < 3; row++) {
        setValue(q, b);
        key(' ', { ctrlKey: true });
        await flush();
        const option = options()[row];
        if (!option) break;
        const from = Number(option.dataset.from);
        const to = Number(option.dataset.to);
        const insert = option.dataset.insert ?? '';
        const kind = option.dataset.kind ?? '';
        if (kind === 'recent' || kind === 'view') continue; // these replace the whole query, by design
        act(() => option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
        await flush();
        const result = textarea().value;
        const caret = textarea().selectionStart ?? result.length;
        const structural = kind !== 'keyword' && kind !== 'snippet';
        const label = `${JSON.stringify(q)} @${b} row ${row} (${kind} ${JSON.stringify(insert)}) → ${JSON.stringify(result)}`;
        if (result !== q) {
          accepted += 1;
          if (!withinRules(q, from, to, result, caret, structural)) broken.push(label);
        } else if (insert !== q.slice(from, to)) {
          // Refused: that is right only when no form of the row would have kept the other terms.
          const forms = [insert, insert.trimEnd()];
          const kept = forms.some((f) => withinRules(q, from, to, q.slice(0, from) + f + q.slice(to), from + f.length, structural));
          if (kept) broken.push(`${label} (refused, though it was safe)`);
        }
      }
    }
  }
  expect(broken).toEqual([]);
  expect(accepted).toBeGreaterThan(500);
}, 900_000);

// After the boundary phase: running each query adds it to the recent queries, whose rows replace the whole query by design.
it('typed and run with plain Enter, every valid query is submitted exactly as typed', async () => {
  const changed: string[] = [];
  for (const q of corpus) {
    setValue('');
    for (let i = 1; i <= q.length; i++) setValue(q.slice(0, i));
    await flush();
    submit.mockClear();
    key('Enter');
    const sent = submit.mock.calls.at(-1)?.[0];
    if (sent !== q) changed.push(`${JSON.stringify(q)} → ${JSON.stringify(sent)}`);
  }
  expect(changed).toEqual([]);
}, 900_000);
