import { apiErrorSchema } from '@trailmark/contracts';
import { type DescribeRouteOptions, describeRoute, resolver } from 'hono-openapi';
import type { z } from 'zod';

/** Metadata only; IDs derive from fixed summaries, never registration order. */
export function routeDoc(summary: string, options: DescribeRouteOptions = {}, security = 'session') {
  const tag = security === 'session' ? 'console' : security === 'none' ? 'system' : 'public/v1';
  return describeRoute({
    summary,
    operationId: `${tag === 'public/v1' ? 'public' : tag}_${summary.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    tags: [tag],
    security: security === 'none' ? [] : [{ [security]: [] }],
    ...options,
    responses: {
      default: { description: 'Request failed', content: { 'application/json': { schema: resolver(apiErrorSchema) } } },
      ...options.responses,
    },
  });
}

export const doc = (summary: string, schema: z.ZodType, status = 200, security = 'session') =>
  routeDoc(summary, { responses: { [status]: { description: summary, content: { 'application/json': { schema: resolver(schema) } } } } }, security);
