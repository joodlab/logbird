import { isTrailQueryError, type ReadOptions, readAuditTrail, type SearchSnapshot, snapshotSearchQuery } from '@logbird/sdk/read';
import { createError, defineEventHandler, getQuery, setResponseHeader } from 'h3';
import type { LogbirdHooks } from './hooks';

const incomplete = () => createError({ statusCode: 400, statusMessage: 'Audit trail query is incomplete' });
export function createReadHandler(options: ReadOptions, hooks: LogbirdHooks) {
  return defineEventHandler(async (event) => {
    setResponseHeader(event, 'Cache-Control', 'private, no-store');
    const query: Record<string, unknown> = getQuery(event);
    let trusted: Awaited<ReturnType<LogbirdHooks['authorize']>>;
    try {
      trusted = await hooks.authorize(event, Object.freeze(query));
    } catch (cause) {
      // trailQuery refuses an incomplete trail (#263): answer with an error, never a wider read. Other failures of the
      // hook stay what they are.
      if (isTrailQueryError(cause)) throw incomplete();
      throw cause;
    }
    if (!trusted || typeof trusted !== 'object') throw createError({ statusCode: 403, statusMessage: 'Audit access denied' });
    // The boundary: the trusted query becomes one frozen snapshot of primitives, each known key read once, and only
    // that snapshot is checked and sent. A value of the wrong type is refused, not converted.
    let outbound: SearchSnapshot;
    try {
      outbound = snapshotSearchQuery(trusted, 'authorize');
    } catch (cause) {
      if (isTrailQueryError(cause)) throw incomplete();
      throw cause;
    }
    // A trusted query without a selector would read the whole project: refuse it rather than forward it.
    if (outbound.q === undefined || !outbound.q.trim()) throw incomplete();
    return readAuditTrail(options, outbound);
  });
}
