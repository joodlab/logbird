import { apiErrorSchema, projectInOtherWorkspaceErrorSchema } from '@logbird/contracts';
import { type DescribeRouteOptions, describeRoute, resolver } from 'hono-openapi';
import type { z } from 'zod';

/** Metadata only; IDs derive from fixed summaries, never registration order. */
export function routeDoc(summary: string, options: DescribeRouteOptions = {}, security = 'session') {
  const tag = security === 'session' ? 'console' : security === 'none' ? 'system' : 'public/v1';
  const publicApi = security === 'ingestKey' || security === 'readKey' || security === 'readKeyOrViewerToken';
  // Read routes accept a read/scoped-read key or a viewer token: either scheme satisfies the operation.
  const requirements: Record<string, string[]>[] =
    security === 'none' ? [] : security === 'readKeyOrViewerToken' ? [{ readKey: [] }, { viewerToken: [] }] : [{ [security]: [] }];
  const headers = {
    'RateLimit-Limit': {
      description:
        'Requests per minute of the tightest bucket that applies: the project bucket for its key kind; for viewer-token reads the minting key + tenant bucket when it is tighter; for minting, the per-key mint bucket',
      schema: { type: 'integer' as const },
    },
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
        Object.entries(options.responses ?? {}).map(([status, response]) => [
          status,
          // Route-specific headers (e.g. the export id) are kept next to the rate-limit headers.
          publicApi ? { ...response, headers: { ...headers, ...('headers' in response ? response.headers : {}) } } : response,
        ]),
      ),
      ...(publicApi
        ? {
            429: {
              description: `${
                options.responses && 429 in options.responses && 'description' in options.responses[429]
                  ? `${options.responses[429].description} Otherwise: `
                  : ''
              }a request budget is exhausted (the project bucket; for viewer tokens the minting key + tenant bucket; for minting the per-key bucket) or the peer authentication-failure budget is. Public limits fail open if Redis is unavailable.`,
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

/**
 * The committed export in `openapi/` names the documented local default instead of this instance's `APP_URL`, so the
 * files depend only on the code and CI can check them for drift. The document the server serves at `/openapi.json`
 * (and the API reference built from it) keeps `APP_URL` (`app.ts`).
 */
export const EXPORT_SERVERS = [{ url: 'http://localhost:4600', description: 'This Logbird instance' }];
export const committedOpenApiDocument = <T extends object>(served: T) => ({ ...served, servers: EXPORT_SERVERS });

/** Every console project route: mounted under requireProjectAccess, so each can answer 409 project_in_other_workspace. */
export const PROJECT_ROUTE_PATH = /^\/api\/projects\/\{projectId\}(?:\/|$)/;
const PROJECT_CONFLICT = 'The project is in another workspace you are a member of (details name it): switch the active workspace to open it.';
const projectConflictSchema = (await resolver(projectInOtherWorkspaceErrorSchema).toOpenAPISchema()).schema;
const generalErrorSchema = (await resolver(apiErrorSchema).toOpenAPISchema()).schema;
type Operation = { responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }> };
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;

/**
 * Documents requireProjectAccess's 409 on every console project operation, from the one middleware rather than per
 * route. anyOf, never oneOf: the general error shape also matches the named one, and a route's other conflicts (its own
 * documented 409, or ones that fell under the default error, such as sample_data_limit or webhook_disabled) must still
 * validate.
 */
export function documentProjectAccess<T extends { paths?: Record<string, unknown> }>(spec: T): T {
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (!PROJECT_ROUTE_PATH.test(path)) continue;
    for (const method of METHODS) {
      const operation = (item as Partial<Record<(typeof METHODS)[number], Operation>>)[method];
      if (!operation) continue;
      if (!operation.responses) operation.responses = {};
      const responses = operation.responses;
      const own = responses['409'];
      const ownSchema = own?.content?.['application/json']?.schema;
      responses['409'] = {
        description: `${own?.description ? `${own.description} Or: ` : ''}${PROJECT_CONFLICT} Other conflicts use the general error shape.`,
        content: { 'application/json': { schema: { anyOf: [...(ownSchema ? [ownSchema] : []), projectConflictSchema, generalErrorSchema] } } },
      };
    }
  }
  return spec;
}
