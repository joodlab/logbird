import { type Audit, type CaptureOptions, createAudit, shutdown } from '@logbird/sdk/integration';
import { createMiddleware } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';

export type { Audit } from '@logbird/sdk/integration';
export { readAuditTrail, trailQuery } from '@logbird/sdk/read';
export function logbird(options: CaptureOptions<Request>) {
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
