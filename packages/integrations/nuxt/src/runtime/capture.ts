import type { Trailmark } from '@trailmark/sdk';
import { type Audit, createAudit } from '@trailmark/sdk/integration';
import { type H3Event, toWebRequest } from 'h3';
import type { TrailmarkHooks } from './hooks';

declare module 'h3' {
  interface H3EventContext {
    audit: Audit;
  }
}
export function attachAudit(event: H3Event, client: Trailmark, hooks: TrailmarkHooks) {
  return createAudit(
    { client, actor: hooks.actor ?? (() => undefined), tenant: hooks.tenant ?? (() => undefined), executor: hooks.executor, onError: hooks.onError },
    event,
    toWebRequest(event),
  ).then((audit) => {
    event.context.audit = audit;
  });
}

export type AuditedH3Event = H3Event;
