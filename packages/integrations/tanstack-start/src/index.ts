import { type Audit, type CaptureOptions, createAudit, shutdown } from '@logbird/sdk/integration';
import { createMiddleware, type FunctionMiddlewareAfterServer, type RequestMiddlewareAfterServer } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';

export type { Audit } from '@logbird/sdk/integration';
export { readAuditTrail, trailQuery } from '@logbird/sdk/read';

// Named through @tanstack/react-start, which the application depends on, so the published declarations never point at
// TanStack's internal packages. The `{}` is TanStack's own "no extra register" type argument.
// biome-ignore lint/complexity/noBannedTypes: TanStack's type parameter is `{}`.
type Register = {};
/** The request middleware: it puts `context.audit` on every request it runs for. */
export type LogbirdRequestMiddleware = RequestMiddlewareAfterServer<Register, undefined, { audit: Audit }>;
/** The function middleware: it runs the request middleware and passes `context.audit` on to server functions. */
export type LogbirdFunctionMiddleware = FunctionMiddlewareAfterServer<
  Register,
  readonly [LogbirdRequestMiddleware],
  undefined,
  { audit: Audit },
  undefined,
  undefined,
  undefined
>;

export function logbird(options: CaptureOptions<Request>): {
  requestMiddleware: LogbirdRequestMiddleware;
  functionMiddleware: LogbirdFunctionMiddleware;
  shutdown: () => Promise<void>;
} {
  const requests = new WeakMap<Request, Promise<Audit>>();
  const forRequest = (request: Request) => {
    let audit = requests.get(request);
    if (!audit) {
      audit = createAudit(options, request, request);
      requests.set(request, audit);
    }
    return audit;
  };
  const requestMiddleware = createMiddleware().server(async ({ request, next }) => {
    const audit = await forRequest(request);
    return next({ context: { audit } });
  });
  const functionMiddleware = createMiddleware({ type: 'function' })
    .middleware([requestMiddleware])
    .server(async ({ context, next }) => next({ context: { audit: context.audit } }));
  return { requestMiddleware, functionMiddleware, shutdown: () => shutdown(options) };
}
// For routes with their own request middleware chain.
export function auditForRequest(options: CaptureOptions<Request>) {
  const request = getRequest();
  return createAudit(options, request, request);
}
