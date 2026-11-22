// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { expect, it, vi } from 'vitest';
import { QueryInput } from './query-input';

vi.mock(import('@tanstack/react-router'), async (original) => ({ ...(await original()), useNavigate: () => vi.fn() }));

it.each([
  ['record: page:7', "(has(target_ids, '7') AND arrayExists((t, i) -> t = 'page' AND i = '7', target_types, target_ids))"],
  ['record:!page:7', null],
  ['free text', null],
])('switches to SQL only with a faithful translation of %s', (value, sql) => {
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
    if (sql === null) {
      expect(submit).not.toHaveBeenCalled();
      expect(host.querySelector('textarea')?.value).toBe(value);
      expect(error).toHaveBeenCalledWith('Could not switch to SQL', expect.anything());
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
