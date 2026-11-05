import { type ReadOptions, readAuditTrail } from '@trailmark/sdk/read';
import { createError, defineEventHandler, getQuery, setResponseHeader } from 'h3';
import type { TrailmarkHooks } from './hooks';
export function createReadHandler(options: ReadOptions, hooks: TrailmarkHooks) {
  return defineEventHandler(async (event) => {
    setResponseHeader(event, 'Cache-Control', 'private, no-store');
    const query: Record<string, unknown> = getQuery(event);
    const trusted = await hooks.authorize(event, Object.freeze(query));
    if (!trusted || typeof trusted !== 'object') throw createError({ statusCode: 403, statusMessage: 'Audit access denied' });
    return readAuditTrail(options, trusted);
  });
}
