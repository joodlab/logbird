/**
 * Route table shared by apps/server (implements) and apps/app (consumes).
 * Paths are relative to the server origin. The app reaches them through a same-origin
 * `/api` + `/v1` proxy in dev (see docs/SPEC.md §5), so the browser never deals with CORS.
 *
 * Auth:
 *  - `session`: better-auth cookie; caller must be a member of the project's organization.
 *  - `ingestKey` / `readKey`: `Authorization: Bearer tm_ingest_…` / `tm_read_…` bound to one project.
 */
export const routes = {
  // better-auth handler (email OTP, organizations, sessions)
  auth: '/api/auth/*',

  me: { method: 'GET', path: '/api/me', auth: 'session' },

  projects: {
    list: { method: 'GET', path: '/api/projects', auth: 'session' },
    create: { method: 'POST', path: '/api/projects', auth: 'session' },
    get: { method: 'GET', path: '/api/projects/:projectId', auth: 'session' },
    update: { method: 'PATCH', path: '/api/projects/:projectId', auth: 'session' },
    remove: { method: 'DELETE', path: '/api/projects/:projectId', auth: 'session' },
    /** Retention status for Settings → Retention (oldest event, last purge run). */
    retention: { method: 'GET', path: '/api/projects/:projectId/retention', auth: 'session' },
  },
  keys: {
    list: { method: 'GET', path: '/api/projects/:projectId/keys', auth: 'session' },
    create: { method: 'POST', path: '/api/projects/:projectId/keys', auth: 'session' },
    revoke: { method: 'DELETE', path: '/api/projects/:projectId/keys/:keyId', auth: 'session' },
  },
  events: {
    search: { method: 'GET', path: '/api/projects/:projectId/events', auth: 'session' },
    get: { method: 'GET', path: '/api/projects/:projectId/events/:eventId', auth: 'session' },
    live: { method: 'GET', path: '/api/projects/:projectId/live', auth: 'session' }, // ?since=<iso>&q= → newest events (polling tail)
    histogram: { method: 'GET', path: '/api/projects/:projectId/histogram', auth: 'session' },
    facets: { method: 'GET', path: '/api/projects/:projectId/facets', auth: 'session' },
    operation: { method: 'GET', path: '/api/projects/:projectId/operations/:operationId', auth: 'session' },
    export: { method: 'GET', path: '/api/projects/:projectId/export', auth: 'session' }, // ?format=csv|jsonl + range query, streamed
    testEvent: { method: 'POST', path: '/api/projects/:projectId/test-event', auth: 'session' },
  },
  overview: { method: 'GET', path: '/api/projects/:projectId/overview', auth: 'session' },
  entities: {
    list: { method: 'GET', path: '/api/projects/:projectId/entities', auth: 'session' },
    profile: { method: 'GET', path: '/api/projects/:projectId/entities/:kind/:entityId', auth: 'session' },
  },
  fields: { method: 'GET', path: '/api/projects/:projectId/fields', auth: 'session' },
  views: {
    list: { method: 'GET', path: '/api/projects/:projectId/views', auth: 'session' },
    create: { method: 'POST', path: '/api/projects/:projectId/views', auth: 'session' },
    remove: { method: 'DELETE', path: '/api/projects/:projectId/views/:viewId', auth: 'session' },
  },
  /** Trailmark's own management actions (project/key/retention/member changes), dogfooded into ClickHouse. */
  workspaceActivity: { method: 'GET', path: '/api/workspace/activity', auth: 'session' },

  /* Public API used by SDKs and customer products */
  public: {
    ingest: { method: 'POST', path: '/v1/events', auth: 'ingestKey' },
    search: { method: 'GET', path: '/v1/events', auth: 'readKey' },
    get: { method: 'GET', path: '/v1/events/:eventId', auth: 'readKey' },
  },

  health: { method: 'GET', path: '/health', auth: 'none' },
  openapi: { method: 'GET', path: '/openapi.json', auth: 'none' },
} as const;
