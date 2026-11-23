import { type ReadOptions, readAuditTrail, type SearchQuery } from '@logbird/sdk/read';
import { createError, defineEventHandler, getQuery, setResponseHeader } from 'h3';
import type { LogbirdHooks } from './hooks';

/** The search parameters the route forwards from the trusted query; anything else is dropped. */
const FORWARDED = ['q', 'lang', 'from', 'to', 'limit', 'cursor', 'order'] as const;
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
    // One plain snapshot, each key read once: what is validated is exactly what is sent (a getter or a non-enumerable
    // property cannot pass the check and then vanish from the request).
    const outbound: Partial<SearchQuery> = {};
    for (const key of FORWARDED) {
      const value = (trusted as Record<string, unknown>)[key];
      if (value !== undefined) (outbound as Record<string, unknown>)[key] = value;
    }
    // A trusted query without a selector would read the whole project: refuse it rather than forward it. A lone UTF-16
    // surrogate would become U+FFFD in the URL and could name a different identifier: refuse that too.
    if (typeof outbound.q !== 'string' || !outbound.q.trim() || /[\uD800-\uDFFF]/u.test(outbound.q))
      throw createError({ statusCode: 400, statusMessage: 'Audit trail query is incomplete' });
    return readAuditTrail(options, outbound);
  });
}
