import { createStart } from '@tanstack/react-start';

/**
 * The console is an authenticated, data-dense tool: every route renders on the client.
 * The server only ships the document shell (and proxies `/api` + `/v1`), so loaders, the
 * API client and the better-auth client always run in the browser with first-party cookies.
 */
export const startInstance = createStart(() => ({
  defaultSsr: false,
}));
