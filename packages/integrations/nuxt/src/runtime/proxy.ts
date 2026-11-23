import { type ReadOptions, readAuditTrail } from '@logbird/sdk/read';
import { createError, defineEventHandler, getQuery, setResponseHeader } from 'h3';
import type { LogbirdHooks } from './hooks';
export function createReadHandler(options: ReadOptions, hooks: LogbirdHooks) {
  return defineEventHandler(async (event) => {
    setResponseHeader(event, 'Cache-Control', 'private, no-store');
    const query: Record<string, unknown> = getQuery(event);
    let trusted: Awaited<ReturnType<LogbirdHooks['authorize']>>;
    try {
      trusted = await hooks.authorize(event, Object.freeze(query));
    } catch (cause) {
      // trailQuery refuses an incomplete trail (#263): answer with an error, never a wider read.
      if (cause instanceof TypeError) throw createError({ statusCode: 400, statusMessage: 'Audit trail query is incomplete' });
      throw cause;
    }
    if (!trusted || typeof trusted !== 'object') throw createError({ statusCode: 403, statusMessage: 'Audit access denied' });
    // A trusted query without a selector would read the whole project: refuse it rather than forward it.
    if (typeof trusted.q !== 'string' || !trusted.q.trim()) throw createError({ statusCode: 400, statusMessage: 'Audit trail query is incomplete' });
    return readAuditTrail(options, trusted);
  });
}
