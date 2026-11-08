import { vi } from 'vitest';

/**
 * Renders whole pages (root shell, header, footer and route) through the real router, in a fresh module graph so the
 * repository state comes from the environment the test sets (vi.stubEnv; cleared first).
 */
export async function renderPages(paths: string[], env: Record<string, string> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { createElement } = await import('react');
  const { renderToString } = await import('react-dom/server');
  const { routeTree } = await import('../routeTree.gen');
  const pages: { path: string; html: string }[] = [];
  for (const path of paths) {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }), isServer: true });
    await router.load();
    pages.push({ path, html: renderToString(createElement(RouterProvider, { router })) });
  }
  return pages;
}

/** Asset URLs (`?url` imports) are empty under vitest, and React warns about the empty stylesheet href. */
export function quietHrefWarnings() {
  const error = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('href')) {
      error(...args);
    }
  });
}
