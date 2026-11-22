// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useSupportCounts } from './support-split';

it('waits for the record selector before requesting the support facet', async () => {
  const root = createRoot(document.createElement('div'));
  const client = new QueryClient();
  const fetch = vi.fn().mockResolvedValue(Response.json({ field: 'impersonator', values: [], otherCount: 0 }));
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  function Counts({ selector }: { selector: string }) {
    useSupportCounts('fictional', 'target', 'page:7', selector, '24h');
    return null;
  }
  const render = (selector: string) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Counts selector={selector} />
        </QueryClientProvider>,
      ),
    );
  try {
    await render('');
    expect(fetch).not.toHaveBeenCalled();
    await render('record:"page:7"');
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetch.mock.calls[0]?.[0]), 'http://localhost');
    expect(url.pathname).toBe('/api/projects/fictional/facets');
    expect(url.searchParams.get('q')).toBe('record:"page:7" impersonator:*');
  } finally {
    act(() => root.unmount());
    client.clear();
    vi.unstubAllGlobals();
  }
});
