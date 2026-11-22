// @vitest-environment happy-dom
import { compileQuery } from '@logbird/clickhouse';
import { formatRecordTerm } from '@logbird/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { expect, it, vi } from 'vitest';
import { fieldsQuery, suggestQuery } from '@/lib/api/queries';
import { QueryInput } from './query-input';

vi.mock(import('@tanstack/react-router'), async (original) => ({ ...(await original()), useNavigate: () => vi.fn() }));

it.each([
  {
    name: 'record pair',
    value: 'record: page:7',
    sql: "(has(target_ids, '7') AND arrayExists((t, i) -> t = 'page' AND i = '7', target_types, target_ids))",
  },
  { name: 'unsupported record syntax', value: 'record:!page:7', message: 'no exact SQL translation' },
  { name: 'free text', value: 'free text', message: 'no exact SQL translation' },
  { name: 'unfinished presence operand', value: '_exists_:"record', message: 'no exact SQL translation' },
  { name: 'invalid bare presence operand', value: '_exists_:record:page', message: 'no exact SQL translation' },
  {
    name: 'long record group',
    value: `record:(${Array.from({ length: 50 }, (_, i) => `p:${i + 1}`).join(' OR ')})`,
    message: '4096-byte SQL limit',
  },
  { name: 'multibyte record ID', value: `record:p:${'🦜'.repeat(600)}`, message: '4096-byte SQL limit' },
])('switches to SQL only with a usable translation of $name', ({ value, sql, message }) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  const submit = vi.fn();
  const error = vi.spyOn(toast, 'error').mockImplementation(() => 'translation-error');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  try {
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <QueryInput allowSql lang="query" onSubmit={submit} projectId="fictional" range="24h" value={value} />
        </QueryClientProvider>,
      ),
    );
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'SQL');
    expect(button).toBeDefined();
    act(() => button?.click());
    if (message) {
      expect(submit).not.toHaveBeenCalled();
      expect(host.querySelector('textarea')?.value).toBe(value);
      expect(host.querySelector('textarea')?.getAttribute('aria-label')).toBe('Query');
      expect(error).toHaveBeenCalledWith('Could not switch to SQL', { description: expect.stringContaining(message) });
    } else {
      expect(submit).toHaveBeenCalledExactlyOnceWith(sql, 'sql');
      expect(error).not.toHaveBeenCalled();
    }
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
    error.mockRestore();
    vi.unstubAllGlobals();
  }
});

it.each([
  { name: 'a generated CR', separator: '\r', legacy: false },
  { name: 'a generated CRLF', separator: '\r\n', legacy: false },
  { name: 'a saved literal CR', separator: '\r', legacy: true },
])('preserves $name when editing and copying a record selector into a fresh editor', ({ separator, legacy }) => {
  const id = `A${separator}B* and \\r`;
  const visible = formatRecordTerm('page', id);
  const value = legacy ? visible.replace('\\r', '\r') : visible;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  client.setQueryData(fieldsQuery('fictional', '24h').queryKey, { data: [], avgConformance: 0 });
  client.setQueryData(suggestQuery('fictional', 'action', '').queryKey, { field: 'action', values: [], complete: true });
  const submit = vi.fn();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  try {
    const render = (query: string, key: string) => {
      act(() =>
        root.render(
          <QueryClientProvider client={client}>
            <QueryInput key={key} lang="query" onSubmit={submit} projectId="fictional" range="24h" value={query} />
          </QueryClientProvider>,
        ),
      );
      const input = host.querySelector('textarea');
      if (!input) throw new Error('Missing query editor');
      return input;
    };
    const input = render(value, 'source');
    expect(input.value).toBe(visible);
    expect(input.value).not.toContain('\r');
    const setNativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    const edit = (target: HTMLTextAreaElement, text: string, caret: number) =>
      act(() => {
        setNativeValue?.call(target, text);
        target.setSelectionRange(caret, caret);
        target.dispatchEvent(new Event('input', { bubbles: true }));
      });
    const prefix = 'outcome:success ';
    edit(input, prefix + visible, prefix.length);
    const suffix = ' action:booked';
    edit(input, prefix + visible + suffix, prefix.length + visible.length + suffix.length);

    // happy-dom has no default clipboard action. Emulate the browser copying the selected textarea text.
    input.setSelectionRange(prefix.length, prefix.length + visible.length);
    const selected = input.value.slice(input.selectionStart, input.selectionEnd);
    const fresh = render('', 'destination');
    expect(fresh.value).toBe('');
    edit(fresh, selected, selected.length);
    act(() => fresh.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ctrlKey: true, key: 'Enter' })));
    expect(submit).toHaveBeenCalledExactlyOnceWith(visible, 'query');
    expect(compileQuery(submit.mock.calls[0]?.[0])).toEqual(compileQuery(value));
    expect(compileQuery(submit.mock.calls[0]?.[0]).params).toMatchObject({ recordId0: id });
  } finally {
    act(() => root.unmount());
    client.clear();
    host.remove();
    vi.unstubAllGlobals();
  }
});
