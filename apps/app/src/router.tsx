import { QueryClient } from '@tanstack/react-query';
import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { NotFound } from '@/components/not-found';
import { RouteError } from '@/components/route-states';
import { ApiRequestError } from '@/lib/api/errors';
import { routeTree } from './routeTree.gen';

export interface RouterContext {
  queryClient: QueryClient;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        staleTime: 20_000,
        retry: (failureCount, error) => !(error instanceof ApiRequestError && error.status < 500) && failureCount < 2,
      },
    },
  });
}

export function getRouter() {
  const queryClient = createQueryClient();
  return createTanStackRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Pages scroll inside the shell's inset panel, not the window: reset that container on navigation too.
    scrollToTopSelectors: ['#app-main'],
    defaultPreload: 'intent',
    // Query owns caching; loaders only warm it.
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: () => <NotFound />,
    defaultPendingMs: 150,
    defaultPendingMinMs: 250,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
