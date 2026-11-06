import type { Logbird } from '@logbird/sdk';
import { type Audit, createAudit } from '@logbird/sdk/integration';
import { type H3Event, toWebRequest } from 'h3';
import type { LogbirdHooks } from './hooks';

declare module 'h3' {
  interface H3EventContext {
    audit: Audit;
  }
}
export function attachAudit(event: H3Event, client: Logbird, hooks: LogbirdHooks) {
  return createAudit(
    { client, actor: hooks.actor ?? (() => undefined), tenant: hooks.tenant ?? (() => undefined), executor: hooks.executor, onError: hooks.onError },
    event,
    toWebRequest(event),
  ).then((audit) => {
    event.context.audit = audit;
  });
}

export type AuditedH3Event = H3Event;
