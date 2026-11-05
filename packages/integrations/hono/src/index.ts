import { type Audit, type CaptureOptions, createAudit, report, shutdown } from '@trailmark/sdk/integration';
import type { Context, MiddlewareHandler } from 'hono';

export type { Audit } from '@trailmark/sdk/integration';
export interface AuditVariables {
  audit: Audit;
}
export interface TrailmarkOptions extends CaptureOptions<Context> {
  autoTrack?: { methods?: string[]; skip?: (context: Context) => boolean };
}
export function trailmark(options: TrailmarkOptions): MiddlewareHandler<{ Variables: AuditVariables }> & { shutdown: () => Promise<void> } {
  const middleware: MiddlewareHandler<{ Variables: AuditVariables }> = async (c, next) => {
    const audit = await createAudit(options, c, c.req.raw);
    c.set('audit', audit);
    try {
      await next();
    } finally {
      try {
        const auto = options.autoTrack;
        if (auto && (auto.methods ?? ['POST', 'PUT', 'PATCH', 'DELETE']).includes(c.req.method) && !auto.skip?.(c))
          audit(`http.${c.req.method.toLowerCase()}`, {
            outcome: c.error || c.res.status >= 400 ? 'failure' : 'success',
            metadata: { path: c.req.path, status: c.res.status },
          });
      } catch (error) {
        report(options.onError, error);
      }
      // Hono throws when no execution context exists on Node.
      let execution: { waitUntil: (promise: Promise<unknown>) => void } | undefined;
      try {
        execution = c.executionCtx;
      } catch {
        /* Node host owns shutdown */
      }
      if (execution) execution.waitUntil(options.client.flush().catch((error) => report(options.onError, error)));
    }
  };
  return Object.assign(middleware, { shutdown: () => shutdown(options) });
}
