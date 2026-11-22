// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { expect, it, vi } from 'vitest';
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
