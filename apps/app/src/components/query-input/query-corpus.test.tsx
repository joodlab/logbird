// @vitest-environment happy-dom
/**
 * The query bar against a whole corpus of valid queries, not the cases found so far (#220 follow-up, a maintainer's
 * condition). The corpus is every query literal in the server parser's own tests and in the console's query tests
 * (each review's cases), kept when the server accepts it. For each query, with the completion panel live against a
 * fixture:
 * 1. typed character by character and run with plain Enter, the submitted text is the typed text, character for
 *    character;
 * 2. with the caret at every term boundary the server's parse gives, a completion chosen with ↓ and accepted with Enter
 *    leaves a query that parses (or does once a value is typed at the caret) and every term away from the caret
 *    unchanged in the server's parse.
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

import { coreField } from '@/lib/query-catalog';
import { termsOutside } from '@/lib/query-language';
import { lintQuery } from '@/lib/query-lint';
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
const unescape = (s: string) => s.replace(/\\(.)/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
const parses = (q: string) => {
  try {
    parseQueryExpression(q);
    return true;
  } catch {
    return false;
  }
};
const corpus = [
  ...new Set(
    SOURCES.flatMap((file) => {
      const text = readFileSync(resolve(ROOT, file), 'utf8');
      return [...text.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)].map((m) => unescape(m[1] ?? m[2] ?? ''));
    }),
  ),
]
  // Queries only: a field or a group, no control characters (a textarea has its own rules for those), as the server accepts them.
  .filter((q) => q.length > 2 && q.length <= 160 && q === q.trim() && /[:(]/.test(q) && !/[\0-\x1f]/.test(q) && parses(q))
  .sort();

/** As the bar decides it: a core field, an explicit attribute, or a key the fixture lists. */
const isFieldName = (name: string) =>
  Boolean(coreField(name)) || /^(attr|attributes)\.\S/.test(name) || fixture.fields.some((f) => f.key === `attr.${name}`);

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
const setValue = (value: string, caret = value.length) =>
  act(() => {
    const t = textarea();
    setNative?.call(t, value);
    t.setSelectionRange(caret, caret);
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });
const key = (k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: k, ...init }));
  });

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
  expect(corpus.length).toBeGreaterThan(60);
});

/** Term boundaries of the server's parse: where each field term starts, where its value starts, and where it ends. */
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

/** The span of the terms at `caret` (the one being completed): every term touching it. */
function termSpanAt(q: string, caret: number): [number, number] {
  let from = caret;
  let to = caret;
  const visit = (node: QueryAtom) => {
    if (node.kind === 'not') visit(node.operand);
    else if (node.kind === 'group') for (const b of node.expression) for (const p of b) visit(p.atom);
    else if (node.start <= caret && node.end >= caret) {
      from = Math.min(from, node.start);
      to = Math.max(to, node.end);
    }
  };
  for (const b of parseQueryExpression(q)) for (const p of b) visit(p.atom);
  return [from, to];
}

it('a completion accepted at any term boundary changes only the term there, and the query still parses', async () => {
  const broken: string[] = [];
  for (const q of corpus) {
    for (const b of boundaries(q)) {
      setValue(q, b);
      key(' ', { ctrlKey: true });
      await flush();
      if (!host.querySelector('[role="option"]')) continue;
      key('ArrowDown');
      // A fix row converts the spelling it names (`tenant =` → `tenant:`), its own span, not only the term at the caret.
      const chosenFix = host.querySelector('[role="option"][aria-selected="true"]')?.getAttribute('data-kind') === 'fix';
      key('Enter');
      await flush();
      const result = textarea().value;
      if (result === q) continue;
      const caret = textarea().selectionStart ?? result.length;
      // Parses as it is, or once a value is typed at the caret (a key or a group awaiting it).
      const finished = parses(result) ? result : `${result.slice(0, caret)}x${result.slice(caret)}`;
      let [from, to] = termSpanAt(q, b);
      if (chosenFix)
        for (const f of lintQuery(q, isFieldName)) {
          from = Math.min(from, f.start);
          to = Math.max(to, f.end);
        }
      const grown = finished.length - q.length;
      const same = parses(finished) && termsOutside(finished, from, to + grown) === termsOutside(q, from, to);
      if (!same) broken.push(`${JSON.stringify(q)} @${b} → ${JSON.stringify(result)}`);
    }
  }
  expect(broken).toEqual([]);
}, 600_000);

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
}, 600_000);
