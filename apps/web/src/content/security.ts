import { SECURITY_EMAIL } from '../env';
import { byRepo, SITE } from './site';

/**
 * Words of /security. Brief: marketing/copy/security.md. No certifications, no claims about Cloud-side logging. The
 * scoped-read limits are content/scoped-read-limits.ts. Inline marks: `code` and **bold** (components/marketing/rich.tsx).
 */
const impersonationSample = `{
  "action": "room.rate.updated",
  "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad", "email": "lina@example.test" },
  "impersonator": { "id": "usr_7", "name": "Omar Saleh" },
  "tenant": { "id": "biz_7", "name": "Azure Hotels" },
  "targets": [{ "type": "room", "id": "room_12", "name": "Room 12" }]
}`;

export const security = {
  samples: { impersonationSample },
  hero: {
    eyebrow: 'Security',
    title: 'How Logbird handles your data.',
    lead: `An audit log holds sensitive history, so this page says what Logbird does with it and where each protection stops.${byRepo(SITE, {
      public: " The repository's `SECURITY.md` and `docs/SPEC.md` have the details.",
      private: '',
    })}`,
  },
  contents: {
    label: 'On this page',
    items: [
      { id: 'self-host', label: 'Where data lives' },
      { id: 'retention', label: 'Retention' },
      { id: 'isolation', label: 'Projects and keys' },
      { id: 'webhooks', label: 'Webhook endpoints' },
      { id: 'sql-guard', label: 'SQL mode' },
      { id: 'roles', label: 'Roles' },
      { id: 'impersonation', label: 'Impersonation' },
      { id: 'self-audit', label: 'Workspace activity' },
      { id: 'limits', label: 'Rate limits and delivery' },
      { id: 'reporting', label: 'Responsible disclosure' },
      { id: 'dont-claim', label: "What we don't claim" },
    ],
  },
  selfHost: {
    eyebrow: 'Where data lives',
    title: 'Self-hosted, your events stay on your servers.',
    lead: "When you self-host, events are stored in your own ClickHouse, and workspaces, projects and keys in your own Postgres. The self-hosted software doesn't send usage data back to us. In the bundled deployment, the server connects out to the SMTP provider you choose and, when you add webhook endpoints, delivers events to them; it resolves an endpoint's hostname when you save it and before each delivery.",
    diagram: {
      server: 'Your server',
      parts: ['Console', 'API', 'Worker', 'Postgres', 'ClickHouse', 'Redis'],
      arrow: 'sign-in codes, invitations',
      smtp: 'Your SMTP provider',
      caption:
        "The bundled Compose deployment: the console, API, worker, Postgres, ClickHouse and Redis all run on your server. Outbound, the server connects to your SMTP provider (sign-in codes, invitations and membership notices) and delivers webhooks to the endpoints you add, looking up each endpoint's hostname when you save it and before each delivery. With your own databases, it also connects to them.",
    },
  },
  retention: {
    eyebrow: 'Retention',
    title: 'Expired events are permanently deleted.',
    bullets: [
      'Each project has a retention window, from 7 days to 10 years. New projects start at 90 days.',
      'A worker deletes events older than the window every hour. Each run is recorded and shown in Settings.',
      "Before you lower retention, Logbird shows roughly how many events it will delete. To confirm, you type the project's slug. The purge starts right away.",
      'Deleting a project deletes all of its events.',
      "**There's no archive and no undo.**",
    ],
  },
  isolation: {
    eyebrow: 'Projects and keys',
    title: 'Every key belongs to one project and does one job.',
    features: {
      bound: { title: 'Project-bound keys', body: 'An API key works for exactly one project.' },
      kinds: {
        title: 'Two kinds',
        body: 'Ingest keys (`lb_ingest_...`) can only write. Read keys (`lb_read_...`) can only read.',
      },
      hashed: {
        title: 'Stored hashed',
        body: 'Logbird keeps a SHA-256 hash and a short display prefix. The full key is shown once, when you create it.',
      },
      revocable: { title: 'Revocable', body: 'Revoke a key in Settings; the console shows when each key was last used.' },
      boundaries: {
        title: 'Workspace boundaries',
        body: "The server checks on every request that the project belongs to your active workspace. A request for another workspace's project gets a 404 and reveals nothing about it.",
      },
    },
    scoped: {
      title: 'Scoped reads: one customer account per key or token.',
      scope: 'One account per scope',
      layers: 'Two layers',
      origins: 'Browser origins',
    },
    /** Code citations: marketing/copy/security.md § webhooks. */
    webhooks: {
      title: 'Webhook endpoints: signed, checked, and managed by admins.',
      admins: {
        title: 'Owners and admins only',
        body: 'Only owners and admins can see or manage webhook endpoints: a stored URL can itself be a credential.',
      },
      secrets: {
        title: 'Secrets shown once',
        body: "Each endpoint's signing secret is encrypted at rest (AES-256-GCM) and shown once, when you create or rotate it.",
      },
      destinations: {
        title: 'Public destinations only',
        body: 'A destination must resolve only to public addresses. Logbird checks it when you save the URL and again before every delivery, and connects only to the address it checked.',
      },
      redirects: {
        title: 'No redirects, no console credentials',
        body: 'Redirects are never followed: a redirect counts as a failed attempt, which is retried within the 24-hour window. A delivery carries the event and its signature headers, never console headers or cookies.',
      },
      masks: {
        title: 'Masks on every delivery',
        body: 'Field masks set on an endpoint apply to every delivery, including retries and resends.',
      },
    },
  },
  sqlGuard: {
    eyebrow: 'SQL mode',
    title: 'SQL search that can only read your project.',
    lead: "SQL mode accepts a single boolean `WHERE` expression. Four layers stand between it and other people's data.",
    steps: [
      {
        title: "Checked against ClickHouse's own parse",
        body: "The server asks ClickHouse for the statement's syntax tree. It rejects anything that isn't exactly Logbird's own query with your condition in it.",
      },
      {
        title: 'Allowlisted',
        rich: 'Only known columns and a fixed list of functions may appear. Subqueries, `UNION`, `WITH`, `SETTINGS`, table functions, system tables, comments and semicolons are rejected.',
      },
      {
        title: 'A restricted user',
        rich: 'Queries run as a separate read-only ClickHouse user. It can only `SELECT`, and it has fixed ceilings on time, rows read, memory and result size.',
      },
      {
        title: 'Row policies',
        rich: "Database row policies limit that user to the project you're authorized for. Even `1 OR 1` can't return another project's rows.",
      },
    ],
    stop: {
      title: 'Where these layers stop',
      body: "These layers protect against a broadened or malformed filter. They don't replace the server's own authorization, and they don't protect against stolen database credentials. SQL mode is for the console only; the public API rejects it.",
    },
  },
  roles: {
    eyebrow: 'Roles',
    title: 'Permissions are checked by the server.',
    lead: "Owners and admins manage projects, keys, retention and invitations. Members search, export, save views and read workspace activity. Any action that isn't explicitly allowed is denied, for every role. The UI hides what you can't do, but the API is what enforces it.",
    codes: { title: 'One-time sign-in codes', body: 'Sign-in is by a one-time code sent by email. There are no passwords to leak.' },
    limited: { title: 'Rate-limited sign-in', body: 'Sign-in requests are rate-limited per client.' },
  },
  impersonation: {
    eyebrow: 'Impersonation',
    title: 'When staff act for a customer, both names are recorded.',
    lead: 'Send the staff member as `impersonator` and keep the customer as `actor`. The event detail shows both. Search `impersonator:*` to list every event done on someone\'s behalf. In the console, those rows are marked "via support", the "Done by support" filter lists them, and each support agent has a page with everything they did while signed in as a customer.',
    codeTitle: 'Support changes a rate for Lina',
    note: 'Lina stays the actor. Omar, from support, is on the event as the impersonator.',
  },
  selfAudit: {
    eyebrow: 'Workspace activity',
    title: 'Logbird records its own management actions.',
    lead: 'Logbird records management actions (projects, keys, retention, invitations) in workspace activity. Every member can read it.',
    actions: ['project.created', 'api_key.created', 'api_key.revoked', 'project.retention.changed'],
    scope: 'workspace',
    caption: 'Examples of management actions in the activity stream.',
  },
  limits: {
    eyebrow: 'Rate limits and delivery',
    title: 'Bounded by design.',
    bullets: [
      'Each project has its own ingest and read rate limits, shared across replicas through Redis.',
      'Failed authentication attempts are limited per client, so repeated bad keys are throttled. Valid keys keep working behind a shared network address.',
      'If Redis fails, sign-in limits fail closed (requests are refused) and ingest and read limits fail open (requests continue).',
      "Delivery is at least once when the client retries unsettled events, as the SDK does. An exact retry with the same valid, non-blank string `id` reuses the stored event while the project retains it, so retries from the SDK, which sets ids, don't add copies; changed content under that id is rejected with `duplicate_id_conflict`. An event sent without an id gets a new one on every retry. Once retention deletes an event, its id can be used again.",
      "Don't send secrets. The SDK's `redact()` helper replaces common secret fields before sending.",
    ],
  },
  reporting: {
    eyebrow: 'Responsible disclosure',
    title: 'Report a vulnerability privately.',
    /** The security contact (components/marketing/security-contact.tsx) sits between these two. */
    before: "Please don't post details in a public issue. ",
    after:
      " Include the affected version, a reproduction using fictional data, and the impact. We'll coordinate the fix and the disclosure with you. We don't offer a response-time SLA yet.",
    email: SECURITY_EMAIL ? { href: `mailto:${SECURITY_EMAIL}`, label: `Email ${SECURITY_EMAIL}` } : undefined,
  },
  dontClaim: {
    eyebrow: "What we don't claim",
    title: 'No certifications yet.',
    body: "Logbird doesn't hold SOC 2, ISO 27001 or any other certification today, and we don't claim that using it makes you compliant with any law or standard. Logbird can help you answer an auditor's questions: who did what, when, in which account, and what changed. The rest of the work is yours, and we'll say so plainly.",
  },
} as const;
