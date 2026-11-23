// @vitest-environment happy-dom
/**
 * The query bar against a whole corpus of valid queries, not the cases found so far (#220 follow-up, a maintainer's
 * condition). The corpus is every literal the parser accepts in the server parser's own tests and in the console's query
 * tests, their generated inputs expanded, and each review's cases. With the completion panel live against a fixture:
 * 1. typed character by character and run with plain Enter, the submitted text is the typed text, character for
 *    character (spaces around it and a blank bar included);
 * 2. at every term boundary of the server's parse (and next to every space and bracket), every row offered (up to
 *    eight), accepted by click, changes only the term at the caret, leaves a query that parses (a row that asks for more
 *    once that is typed, without dropping what was there), and leaves every other term, and how every other character
 *    reads, unchanged in the server's parse, by an oracle written here on the parser. A refused row must have been
 *    unsafe in every form.
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
  'apps/app/src/lib/impersonation.test.ts',
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
// What the tests' generated inputs (`${field}:x*`, `occurredAt:>now-1${unit}`) are generated over.
const PLACEHOLDERS: Record<string, string[]> = {
  field: ['action', 'actor', 'tenant', 'impersonator', 'record', 'attr.plan'],
  k: ['action', 'attr.plan'],
  unit: ['s', 'm', 'h', 'd', 'w'],
  value: ['booked', 'a b'],
};
function expand(template: string): string[] {
  const names = [...template.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1] as string);
  if (template.replace(/\$\{\w+\}/g, '').includes('${') || names.some((n) => !PLACEHOLDERS[n])) return [];
  return names.reduce<string[]>((outs, name) => outs.flatMap((o) => (PLACEHOLDERS[name] ?? []).map((v) => o.replace(`\${${name}}`, v))), [template]);
}
const literals = [
  ...new Set(
    SOURCES.flatMap((file) => {
      const text = readFileSync(resolve(ROOT, file), 'utf8');
      const quoted = [...text.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)].map((m) => unescapeLiteral(m[1] ?? m[2] ?? ''));
      const templates = [...text.matchAll(/`((?:[^`\\\n]|\\.)*)`/g)].flatMap((m) => expand(unescapeLiteral(m[1] ?? '')));
      return [...quoted, ...templates];
    }),
  ),
];
// The cases each review of this bar produced, so they stay covered whatever the tests above say.
const REVIEWED = [
  'one AND two',
  'one OR two',
  'action:b tenant:west',
  'action:"b"-tenant:west',
  'action: (ab"cd OR next) tenant:west',
  'attempt:2',
  'attempt:2 tenant:west',
  'impersonator:(* OR "")',
  'impersonator:(* OR /.*/)',
  'action=OR',
  'plan=pro',
  'NOT _exists_:actor',
  '(((x)))',
  'act',
  'action=booked',
];
// Every literal the parser accepts (free text, KQL-looking text and bare prefixes included), without control characters
// (a textarea has its own rules for those).
const valid = [...new Set([...literals, ...REVIEWED])]
  .filter((q) => q.trim() && q.length <= 160 && ![...q].some((c) => c.charCodeAt(0) < 0x20) && parses(q))
  .sort();
// Enter must also keep spaces around a query, and a blank bar as it is.
const corpus = [
  ...valid,
  ...valid
    .filter((q) => /[:(]/.test(q))
    .slice(0, 40)
    .map((q) => `  ${q} `),
  '  ',
];

/* ---------------- an oracle of its own, from the server's parser ---------------- */

type Leaf = Exclude<QueryAtom, { kind: 'not' | 'group' }>;
/** The server's terms of `q` with their negation and the OR branches they sit in. */
function leaves(q: string): { leaf: Leaf; negated: boolean; path: string }[] | null {
  let expression: ReturnType<typeof parseQueryExpression>;
  try {
    expression = parseQueryExpression(q);
  } catch {
    return null;
  }
  const out: { leaf: Leaf; negated: boolean; path: string }[] = [];
  const walk = (node: QueryAtom, negated: boolean, path: string): void => {
    if (node.kind === 'not') walk(node.operand, !negated, path);
    else if (node.kind === 'group') {
      for (const [i, branch] of node.expression.entries()) for (const p of branch) walk(p.atom, negated, `${path}.${i}`);
    } else out.push({ leaf: node, negated, path });
  };
  for (const [i, branch] of expression.entries()) for (const p of branch) walk(p.atom, false, `${i}`);
  return out;
}

/**
 * Every term of `q` outside `[from, to)` as the server parses it (field or word, value, polarity and, when `structural`,
 * its OR branches), and which characters outside the span belong to a term: an operator glued into a term
 * (`ANDimpersonator:*`) or a term split apart shows in the second even when the terms look alike.
 */
function outside(q: string, from: number, to: number, structural: boolean): string | null {
  const all = leaves(q);
  if (!all) return null;
  const omit = (k: string, v: unknown) => (['start', 'end', 'valueStart', 'key'].includes(k) ? undefined : v);
  const terms = all
    .filter(({ leaf }) => !(leaf.start < to && leaf.end > from))
    .map(({ leaf, negated, path }) =>
      JSON.stringify(
        [structural ? path : '', leaf.kind, leaf.kind === 'field' ? [leaf.field, leaf.value] : [leaf.token.kind, leaf.token.value], negated],
        omit,
      ),
    );
  const inTerm = [...q].map((_, i) => (all.some(({ leaf }) => i >= leaf.start && i < leaf.end) ? '1' : '0'));
  return `${terms.join('\n')}\n${inTerm.slice(0, from).join('')}|${inTerm.slice(to).join('')}`;
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
const input = (value: string, caret: number) =>
  act(() => {
    const t = textarea();
    setNative?.call(t, value);
    t.setSelectionRange(caret, caret);
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });
// React ignores an input event whose value did not change, so the same text with a new caret goes through other text
// first, in its own update.
const setValue = (value: string, caret = value.length) => {
  if (textarea().value === value) input(`${value}#`, value.length + 1);
  input(value, caret);
};
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

it('has a real corpus, generated server inputs and the reviewed cases included', () => {
  expect(valid.length).toBeGreaterThan(900);
  for (const q of ['occurredAt:>now-1w', 'NOT _exists_:actor', 'one AND two', 'action:"b"-tenant:west']) expect(valid).toContain(q);
});

/**
 * Where to try completions: where each server term starts and ends, where a field's value starts, next to every space
 * and bracket (after an operator, between terms), and both ends.
 */
function boundaries(q: string): number[] {
  const at = new Set<number>([0, q.length]);
  for (const { leaf } of leaves(q) ?? []) {
    at.add(leaf.start);
    at.add(leaf.end);
    if (leaf.kind === 'field') at.add(leaf.valueStart);
  }
  for (let i = 1; i < q.length; i++) if (/[\s()]/.test(q[i - 1] ?? '') || /[\s()]/.test(q[i] ?? '')) at.add(i);
  return [...at].sort((a, b) => a - b);
}

/**
 * The part of `q` a completion at `caret` may change: the terms touching the caret (a NOT sign before one included) and
 * the spaces around them. A fix may also take in the words of a comparison (`tenant =`), never another field term.
 */
function editable(q: string, caret: number, from: number, to: number, fix: boolean): boolean {
  const all = leaves(q) ?? [];
  let lo = caret;
  let hi = caret;
  // A term starts at its NOT sign (`-_exists_:tenant`).
  const start = (leaf: Leaf) => (/[-!]/.test(q[leaf.start - 1] ?? '') ? leaf.start - 1 : leaf.start);
  const touches = (leaf: Leaf) => start(leaf) <= caret && leaf.end >= caret;
  for (const { leaf } of all) {
    if (touches(leaf)) {
      lo = Math.min(lo, start(leaf));
      hi = Math.max(hi, leaf.end);
    }
  }
  while (lo > 0 && /\s/.test(q[lo - 1] ?? '')) lo -= 1;
  while (hi < q.length && /\s/.test(q[hi] ?? '')) hi += 1;
  if (from >= lo && to <= hi) return true;
  return fix && all.every(({ leaf }) => !(leaf.start < to && leaf.end > from) || leaf.kind === 'text' || touches(leaf));
}

/** `result` as the reader will finish it: as it is, or (for a row that asks for more) with a word or range bounds typed. */
function finished(result: string, caret: number, asksForMore: boolean): string | undefined {
  if (parses(result)) return result;
  if (!asksForMore) return undefined;
  return [`${result.slice(0, caret)} x${result.slice(caret)}`, result.replace(/([[{])\s*TO\s*([\]}])/, '$1x TO x$2')].find(parses);
}

interface Row {
  from: number;
  to: number;
  insert: string;
  kind: string;
  asksForMore: boolean;
}

/**
 * Whether accepting `row` in `q` with the caret at `caret` gave `result` within the rules: the row's span lies in the
 * term at the caret (which also shows the bar read this caret, not a stale one), the text changed only inside that span, the query parses (a row that asks for more, once that is
 * typed, and then without losing what was there), and every term and every character outside the span reads the same.
 */
function withinRules(q: string, caret: number, row: Row, result: string, resultCaret: number): string | null {
  if (!editable(q, caret, row.from, row.to, row.kind === 'fix')) return 'its span reaches past the term at the caret';
  if (!result.startsWith(q.slice(0, row.from)) || !result.endsWith(q.slice(row.to))) return 'it changed text outside its span';
  const done = finished(result, resultCaret, row.asksForMore);
  if (done === undefined) return 'the result does not parse';
  if (done !== result) {
    // Unfinished on purpose (`action:`, `OR`, `[ TO ]`), it never drops a value already there (`attempt:2` + `>`).
    for (const { leaf } of leaves(q) ?? []) {
      if (leaf.kind !== 'field' || !(leaf.valueStart < row.to && leaf.end > row.from)) continue;
      const was = q.slice(Math.max(leaf.valueStart, row.from), Math.min(leaf.end, row.to)).trim();
      if (was && !result.slice(row.from, result.length - (q.length - row.to)).includes(was))
        return `it dropped the value ${JSON.stringify(was)} and left the query unfinished`;
    }
  }
  const end = row.from + (done.length - (q.length - (row.to - row.from)));
  const structural = row.kind !== 'keyword' && row.kind !== 'snippet';
  return outside(done, row.from, end, structural) === outside(q, row.from, row.to, structural) ? null : 'another term changed';
}

const MAX_ROWS = 8;

it('every row accepted at any term boundary changes only its own term, and the query still parses', async () => {
  const broken: string[] = [];
  let accepted = 0;
  for (const q of ['', '  ', ...valid]) {
    for (const b of boundaries(q)) {
      for (let r = 0; r < MAX_ROWS; r++) {
        setValue(q, b);
        key(' ', { ctrlKey: true });
        await flush();
        const option = options()[r];
        if (!option) break;
        const row: Row = {
          from: Number(option.dataset.from),
          to: Number(option.dataset.to),
          insert: option.dataset.insert ?? '',
          kind: option.dataset.kind ?? '',
          asksForMore: option.dataset.keepOpen !== undefined,
        };
        if (row.kind === 'recent' || row.kind === 'view') continue; // these replace the whole query, by design
        const label = `${JSON.stringify(q)} @${b} row ${r} (${row.kind} ${JSON.stringify(row.insert)} over ${row.from}-${row.to})`;
        act(() => option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
        await flush();
        const result = textarea().value;
        const caret = textarea().selectionStart ?? result.length;
        if (result !== q) {
          accepted += 1;
          const problem = withinRules(q, b, row, result, caret);
          if (problem) broken.push(`${label} → ${JSON.stringify(result)}: ${problem}`);
        } else if (row.insert !== q.slice(row.from, row.to)) {
          // Refused: right only when no form of the row (as built, trimmed, quoted, after a space) keeps the rules.
          const bare = row.insert.trimEnd();
          const forms = [row.insert, bare];
          if (row.kind === 'value' && bare && !/^["/(]/.test(bare) && !bare.endsWith('*')) forms.push(`"${bare.replace(/["\\]/g, '\\$&')}"`);
          if (row.kind !== 'value' && row.from > 0 && !/[\s(]/.test(q[row.from - 1] ?? '')) forms.push(` ${row.insert}`, ` ${bare}`);
          const safe = forms.find((f) => withinRules(q, b, row, q.slice(0, row.from) + f + q.slice(row.to), row.from + f.length) === null);
          if (safe !== undefined) broken.push(`${label}: refused, though ${JSON.stringify(safe)} was safe`);
        }
      }
    }
  }
  expect(broken).toEqual([]);
  expect(accepted).toBeGreaterThan(5000);
}, 1_800_000);

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
