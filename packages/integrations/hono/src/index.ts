import { LogbirdError } from '@logbird/sdk';
import { type Audit, type CaptureOptions, createAudit, report, shutdown } from '@logbird/sdk/integration';
import type { Context, MiddlewareHandler } from 'hono';

export type { Audit } from '@logbird/sdk/integration';
export interface AuditVariables {
  audit: Audit;
}
export interface LogbirdOptions extends CaptureOptions<Context> {
  autoTrack?: { methods?: string[]; skip?: (context: Context) => boolean };
}
export function logbird(options: LogbirdOptions): MiddlewareHandler<{ Variables: AuditVariables }> & { shutdown: () => Promise<void> } {
  const middleware: MiddlewareHandler<{ Variables: AuditVariables }> = async (c, next) => {
    const audit = await createAudit(options, c, c.req.raw);
    c.set('audit', audit);
    try {
      await next();
    } finally {
      let action: string | undefined;
      try {
        const auto = options.autoTrack;
        if (auto && (auto.methods ?? ['POST', 'PUT', 'PATCH', 'DELETE']).includes(c.req.method)) {
          action = `http.${c.req.method.toLowerCase()}`;
          if (!auto.skip?.(c)) {
            audit(action, {
              outcome: c.error || c.res.status >= 400 ? 'failure' : 'success',
              metadata: { path: c.req.path, status: c.res.status },
            });
          }
        }
      } catch {
        report(options.onError, new LogbirdError('capture_failed'), options.client, action);
      }
      // Hono throws when no execution context exists on Node.
      let execution: { waitUntil: (promise: Promise<unknown>) => void } | undefined;
      try {
        execution = c.executionCtx;
      } catch {
        /* Node host owns shutdown */
      }
      if (execution)
        execution.waitUntil(
          audit
            .pending()
            .then(() => options.client.flush())
            .catch((error) => report(options.onError, error, options.client)),
        );
    }
  };
  return Object.assign(middleware, { shutdown: () => shutdown(options) });
}
