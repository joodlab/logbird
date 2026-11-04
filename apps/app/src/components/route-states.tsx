import { type ErrorComponentProps, useRouter } from '@tanstack/react-router';
import { ErrorState } from '@trailmark/ui/components/states';
import { Skeleton } from '@trailmark/ui/components/ui/skeleton';
import { ApiRequestError } from '@/lib/api/errors';
import { placeholderKeys } from '@/lib/placeholders';

/** Default route error boundary: keeps the shell, explains, offers a retry. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const unreachable = error instanceof TypeError || (error instanceof ApiRequestError && error.status >= 502);
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <ErrorState
        error={unreachable ? new Error('The Trailmark server did not answer. Check that it is running on port 4601, then retry.') : error}
        onRetry={() => {
          reset();
          router.invalidate();
        }}
        title={unreachable ? 'Cannot reach the server' : 'This page failed to load'}
      />
    </div>
  );
}

/** Generic page skeleton used while a route's loader warms the cache. */
export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-6 p-6" role="status">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {placeholderKeys(5).map((k) => (
          <Skeleton className="h-24 rounded-xl" key={k} />
        ))}
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}

export function FullPageLoader() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex min-h-svh items-center justify-center" role="status">
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <span className="size-2 animate-pulse rounded-full bg-brand" />
        Loading Trailmark…
      </div>
    </div>
  );
}
