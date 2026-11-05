import { createServerFn } from '@tanstack/react-start';
import { integration } from './audit.server';
export const updateRecord = createServerFn({ method: 'POST' })
  .middleware([integration.functionMiddleware])
  .handler(({ context }) => {
    context.audit('tanstack-start.record.updated', { targets: [{ type: 'record', id: 'demo-record' }] });
    return { ok: true };
  });
