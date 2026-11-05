import { MutationCache, QueryClient } from '@tanstack/react-query';
import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { NotFound } from '@/components/not-found';
import { RouteError } from '@/components/route-states';
import { ApiRequestError } from '@/lib/api/errors';
import { keys, retryDelay, shouldRetry } from '@/lib/api/queries';
import { routeTree } from './routeTree.gen';

export interface RouterContext {
  queryClient: QueryClient;
}

function createQueryClient(): QueryClient {
  const queryClient: QueryClient = new QueryClient({
    // A 403 means the role the console rendered for is out of date (changed by an admin, or never loaded):
    // re-read it so admin-only controls disappear instead of failing again.
    mutationCache: new MutationCache({
      onError: (error) => {
        if (error instanceof ApiRequestError && error.isForbidden) {
          queryClient.invalidateQueries({ queryKey: keys.me });
          queryClient.invalidateQueries({ queryKey: keys.organization });
        }
      },
    }),
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        staleTime: 20_000,
        retry: shouldRetry,
        retryDelay,
      },
    },
  });
  return queryClient;
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
