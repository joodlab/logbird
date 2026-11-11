import { apiErrorSchema } from '@logbird/contracts';
import { type DescribeRouteOptions, describeRoute, resolver } from 'hono-openapi';
import type { z } from 'zod';

/** Metadata only; IDs derive from fixed summaries, never registration order. */
export function routeDoc(summary: string, options: DescribeRouteOptions = {}, security = 'session') {
  const tag = security === 'session' ? 'console' : security === 'none' ? 'system' : 'public/v1';
  const publicApi = security === 'ingestKey' || security === 'readKey' || security === 'readKeyOrViewerToken';
  // Read routes accept a read/scoped-read key or a viewer token: either scheme satisfies the operation.
  const requirements = security === 'none' ? [] : security === 'readKeyOrViewerToken' ? [{ readKey: [] }, { viewerToken: [] }] : [{ [security]: [] }];
  const headers = {
    'RateLimit-Limit': { description: 'Requests per project and key kind per minute', schema: { type: 'integer' as const } },
    'RateLimit-Remaining': { description: 'Requests remaining in this window', schema: { type: 'integer' as const } },
    'RateLimit-Reset': { description: 'Seconds until the fixed window resets', schema: { type: 'integer' as const } },
  };
  return describeRoute({
    summary,
    operationId: `${tag === 'public/v1' ? 'public' : tag}_${summary.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    tags: [tag],
    security: requirements,
    ...options,
    responses: {
      default: { description: 'Request failed', content: { 'application/json': { schema: resolver(apiErrorSchema) } } },
      ...Object.fromEntries(
        Object.entries(options.responses ?? {}).map(([status, response]) => [status, publicApi ? { ...response, headers } : response]),
      ),
      ...(publicApi
        ? {
            429: {
              description: 'Project request budget or peer authentication-failure budget exhausted. Public limits fail open if Redis is unavailable.',
              headers: {
                ...headers,
                'Retry-After': {
                  description: 'Seconds before retrying; budget headers apply only after authentication',
                  schema: { type: 'integer' as const },
                },
              },
              content: { 'application/json': { schema: resolver(apiErrorSchema) } },
            },
          }
        : {}),
    },
  });
}

export const doc = (summary: string, schema: z.ZodType, status = 200, security = 'session') =>
  routeDoc(summary, { responses: { [status]: { description: summary, content: { 'application/json': { schema: resolver(schema) } } } } }, security);
