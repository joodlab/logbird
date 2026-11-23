// @vitest-environment happy-dom
/** What each key does in the query bar: only a row the reader chose changes the query (#290). */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock(import('@tanstack/react-router'), async (original) => ({ ...(await original()), useNavigate: () => vi.fn() }));

const { fixture } = vi.hoisted(() => {
  const fixture = {
    // The project's field names arrive only when a test releases them (a new gate for each test).
    fieldsArrive: Promise.resolve(),
    release: (() => undefined) as () => void,
    gate() {
      fixture.fieldsArrive = new Promise<void>((resolve) => {
        fixture.release = resolve;
      });
    },
    fields: [] as { key: string; kind: string; coverage: number; distinctApprox: number; samples: string[]; lastSeen: null }[],
    values: { action: ['booked', 'booking.created'], actor: ['amy'] } as Record<string, string[]>,
  };
  return { fixture };
});

vi.mock('@/lib/api/client', () => ({
  api: {
    fields: vi.fn(async () => {
      await fixture.fieldsArrive;
      return { data: fixture.fields, avgConformance: 1 };
    }),
    suggest: vi.fn(async (_p: string, { field }: { field: string }) => ({
      field,
      values: (fixture.values[field] ?? []).map((value) => ({ value, label: value, count: 1 })),
      complete: true,
    })),
    views: { list: vi.fn(async () => []) },
    entities: { list: vi.fn(async () => ({ data: [], nextCursor: null })) },
  },
}));

import { QueryInput } from './query-input';

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
/** The bar showing `value`, the query that ran (from the URL, say). */
const render = (value: string) =>
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <QueryInput lang="query" onSubmit={submit} projectId="qa-keys" range="24h" value={value} />
      </QueryClientProvider>,
    ),
  );
const submit = vi.fn();
const textarea = () => host.querySelector('textarea') as HTMLTextAreaElement;
const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(260);
  });
};
const type = (value: string) =>
  act(() => {
    const t = textarea();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(t, value);
    t.setSelectionRange(value.length, value.length);
    t.dispatchEvent(new Event('input', { bubbles: true }));
  });
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...init }));
  });
const options = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')].filter((o) => o.getAttribute('aria-disabled') !== 'true');

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  submit.mockClear();
  fixture.gate();
  fixture.fields = [{ key: 'attr.plan', kind: 'attribute', coverage: 0.4, distinctApprox: 1, samples: ['pro'], lastSeen: null }];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render('');
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('Enter takes only the row chosen with the arrows: once the pointer highlights another, Enter runs the text', async () => {
  type('act');
  await flush();
  press('ArrowDown'); // the second row is now chosen
  const [first] = options();
  expect(options()[1]?.getAttribute('aria-selected')).toBe('true');
  act(() => first?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
  press('Enter');
  expect(submit).toHaveBeenLastCalledWith('act', 'query');
  expect(textarea().value).toBe('act');
});

it('→ at the end of the text takes the highlighted row, even the first one', async () => {
  type('action:');
  await flush();
  const [first] = options();
  expect(first?.dataset.insert?.trim()).toBe('booked');
  press('ArrowRight');
  expect(textarea().value.trim()).toBe('action:booked');
  expect(submit).not.toHaveBeenCalled();
});

it('confirming an IME candidate never applies the offered filter', async () => {
  type('action=booked');
  await flush();
  press('Enter');
  expect(submit).toHaveBeenLastCalledWith('action=booked', 'query');
  expect(host.querySelector('[data-testid="query-conversion"]')).not.toBeNull();
  press('Enter', { altKey: true, isComposing: true });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(textarea().value).toBe('action=booked');
});

it('offers the filter for a project attribute once the field names arrive, even after the search ran', async () => {
  type('plan=pro');
  press('Enter');
  expect(submit).toHaveBeenLastCalledWith('plan=pro', 'query');
  expect(host.querySelector('[data-testid="query-conversion"]')).toBeNull();
  fixture.release();
  await flush();
  await flush();
  expect(host.querySelector('[data-testid="query-conversion"]')?.textContent).toContain('plan:pro');
});

it('right after a closed value group offers OR and AND, and an operator goes after a space', async () => {
  type('action:(booked)');
  await flush();
  const labels = options().map((o) => o.dataset.insert?.trim());
  expect(labels).toEqual(expect.arrayContaining(['OR', 'AND']));
  const dash = options().find((o) => o.dataset.insert?.trim() === '-');
  expect(dash).toBeDefined();
  act(() => dash?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
  // `action:(booked)-tenant:west` would read `-tenant` as a field name; after a space the dash is a NOT.
  expect(textarea().value).toBe('action:(booked) -');
});

it('a row chosen with the arrows stops being chosen when the rows change under it', async () => {
  // Coverage for core fields reorders the key rows without changing how many there are.
  fixture.fields = ['actor', 'action'].map((key) => ({ key, kind: 'core', coverage: 1, distinctApprox: 9, samples: [], lastSeen: null }));
  type(' ');
  await flush();
  press('ArrowDown');
  const chosen = options()[1]?.dataset.insert;
  fixture.release();
  await flush();
  await flush();
  expect(options()[1]?.dataset.insert).not.toBe(chosen);
  press('Enter');
  expect(submit).toHaveBeenLastCalledWith(' ', 'query');
  expect(textarea().value).toBe(' ');
});

it('right after a finished operator a key starts a new term, after a space, and keeps the operator', async () => {
  type('one OR');
  await flush();
  // No second operator is offered right after one.
  expect(options().map((o) => o.dataset.insert?.trim())).not.toContain('OR');
  press('ArrowRight');
  expect(textarea().value).toMatch(/^one OR \S/);
});

it('a KQL-looking search that ran from a link shows its offer at once, and one Alt+Enter applies it', async () => {
  render('action=booked');
  await flush();
  expect(host.querySelector('[data-testid="query-conversion"]')?.textContent).toContain('action:booked');
  press('Enter', { altKey: true });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenLastCalledWith('action:booked', 'query');
});
