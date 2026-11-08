/**
 * Route table shared by apps/server (implements) and apps/app (consumes).
 * Paths are relative to the server origin. The app reaches them through a same-origin
 * `/api` + `/v1` proxy in dev (see docs/SPEC.md §5), so the browser never deals with CORS.
 *
 * Auth:
 *  - `session`: better-auth cookie; caller must be a member of the project's organization.
 *  - `ingestKey` / `readKey`: `Authorization: Bearer lb_ingest_…` / `lb_read_…` bound to one project.
 */
export const routes = {
  // better-auth handler (email OTP, organizations, sessions)
  auth: '/api/auth/*',

  me: { method: 'GET', path: '/api/me', auth: 'session' },
  /** Self-only session mutations. Evidence and exactly the selected ids commit atomically. */
  sessions: {
    signOut: { method: 'POST', path: '/api/session/sign-out', auth: 'session' },
    revoke: { method: 'POST', path: '/api/sessions/revoke', auth: 'session' },
    revokeAll: { method: 'POST', path: '/api/sessions/revoke-all', auth: 'session' },
    revokeOthers: { method: 'POST', path: '/api/sessions/revoke-others', auth: 'session' },
  },
  workspace: { method: 'PATCH', path: '/api/workspace', auth: 'session' },

  projects: {
    list: { method: 'GET', path: '/api/projects', auth: 'session' },
    create: { method: 'POST', path: '/api/projects', auth: 'session' },
    get: { method: 'GET', path: '/api/projects/:projectId', auth: 'session' },
    update: { method: 'PATCH', path: '/api/projects/:projectId', auth: 'session' },
    /** Requires ?confirm=<project slug>. */
    remove: { method: 'DELETE', path: '/api/projects/:projectId', auth: 'session' },
    /** Retention status for Settings → Retention (oldest event, last purge run). */
    retention: { method: 'GET', path: '/api/projects/:projectId/retention', auth: 'session' },
    /** Setup checklist (ProjectSetup, ./setup.ts). Cheap to poll: the first-event step polls it every few seconds. */
    setup: { method: 'GET', path: '/api/projects/:projectId/setup', auth: 'session' },
    /** Load (POST → SampleDataResponse) or remove (DELETE → 204) synthetic sample events. */
    sampleData: { method: 'POST', path: '/api/projects/:projectId/sample-data', auth: 'session' },
    removeSampleData: { method: 'DELETE', path: '/api/projects/:projectId/sample-data', auth: 'session' },
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
    export: { method: 'GET', path: '/api/projects/:projectId/export', auth: 'session' }, // exportQuerySchema; streamed
    testEvent: { method: 'POST', path: '/api/projects/:projectId/test-event', auth: 'session' },
  },
  overview: { method: 'GET', path: '/api/projects/:projectId/overview', auth: 'session' },
  entities: {
    list: { method: 'GET', path: '/api/projects/:projectId/entities', auth: 'session' },
    profile: { method: 'GET', path: '/api/projects/:projectId/entities/:kind/:entityId', auth: 'session' },
  },
  fields: { method: 'GET', path: '/api/projects/:projectId/fields', auth: 'session' },
  /** Value autocomplete for the query bar (suggestQuerySchema → SuggestResponse, ./query.ts). */
  suggest: { method: 'GET', path: '/api/projects/:projectId/suggest', auth: 'session' },
  views: {
    list: { method: 'GET', path: '/api/projects/:projectId/views', auth: 'session' },
    create: { method: 'POST', path: '/api/projects/:projectId/views', auth: 'session' },
    remove: { method: 'DELETE', path: '/api/projects/:projectId/views/:viewId', auth: 'session' },
  },
  /** Logbird's own management actions (project/key/retention/member changes), dogfooded into ClickHouse. */
  workspaceActivity: { method: 'GET', path: '/api/workspace/activity', auth: 'session' },
  exportStatus: { method: 'GET', path: '/api/workspace/exports/:exportId', auth: 'session' },
  /** Workspace setup summary + resumable onboarding target (WorkspaceSetup, ./setup.ts). */
  workspaceSetup: { method: 'GET', path: '/api/workspace/setup', auth: 'session' },
  /**
   * Members & invitations use better-auth's organization endpoints under /api/auth/organization/*
   * (invite-member, list-invitations, get-invitation, accept-invitation, reject-invitation, cancel-invitation,
   * list-members, update-member-role, remove-member). Invite emails link to `${APP_URL}/accept-invitation/:id`.
   */
  invitations: {
    /** Public preview for the accept page (InvitationPreview, ./invitations.ts): works signed out, 404 when unknown. */
    preview: { method: 'GET', path: '/api/invitations/:invitationId', auth: 'none' },
  },
  /** Shareable join links (./invitations.ts). Create/list/revoke need owner/admin of the active workspace. */
  inviteLinks: {
    list: { method: 'GET', path: '/api/workspace/invite-links', auth: 'session' },
    create: { method: 'POST', path: '/api/workspace/invite-links', auth: 'session' },
    revoke: { method: 'DELETE', path: '/api/workspace/invite-links/:linkId', auth: 'session' },
    preview: { method: 'GET', path: '/api/invite-links/:token', auth: 'none' },
    accept: { method: 'POST', path: '/api/invite-links/:token/accept', auth: 'session' },
  },

  /* Public API used by SDKs and customer products */
  public: {
    ingest: { method: 'POST', path: '/v1/events', auth: 'ingestKey' },
    search: { method: 'GET', path: '/v1/events', auth: 'readKey' },
    get: { method: 'GET', path: '/v1/events/:eventId', auth: 'readKey' },
  },

  health: { method: 'GET', path: '/health', auth: 'none' },
  openapi: { method: 'GET', path: '/openapi.json', auth: 'none' },
} as const;
