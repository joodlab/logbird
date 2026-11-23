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

/**
 * React's warning for an empty `href`, verbatim from react-dom 19's server renderer
 * (cjs/react-dom-server.node.development.js; an empty `src` gets a longer variant). The attribute name is a format
 * argument (twice), not part of the string.
 */
const EMPTY_ATTRIBUTE_WARNING =
  'An empty string ("") was passed to the %s attribute. To fix this, either do not render the element at all or pass null to %s instead of an empty string.';

/** Asset URLs (`?url` imports) are empty under vitest, and React warns about the empty stylesheet href. */
export function quietHrefWarnings() {
  const error = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    // Only that exact warning, for an `href`. Every other error, a changed React message included, still prints.
    const emptyHref = args[0] === EMPTY_ATTRIBUTE_WARNING && args[1] === 'href';
    if (!emptyHref) {
      error(...args);
    }
  });
}
