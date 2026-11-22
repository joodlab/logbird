import { DESIGN_PARTNER_LINE } from '../lib/copy-flags';
import { selfHostQuickstart } from '../lib/selfhost';
import { sharedContent } from './shared';
import { byRepo, type Cta, type Item, type Marked, SITE, type SiteState } from './site';

/**
 * The home page's words (routes/index.tsx). Brief: marketing/copy/home.md (messaging, proof and owner notes).
 * Every claim here must be true of the product today; the sources are listed in the brief.
 */

/** Head metadata, read by lib/site-map.ts. */
export const homeMeta = {
  title: 'Home',
  description: 'Open-source audit logs you can self-host.',
};

const curl = `curl http://localhost:4600/v1/events \\
  -H "Authorization: Bearer $LOGBIRD_INGEST_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"action":"booking.cancelled"}'`;

const routeSample = `// Route (Hono)
app.post('/bookings/:id/cancel', async (c) => {
  const id = c.req.param('id');
  // ...cancel the booking
  const eventId = c.var.audit('booking.cancelled', {
    targets: [{ type: 'booking', id }],
    changes: [
      { field: 'status', before: 'confirmed', after: 'cancelled' },
    ],
  });
  const carrier = await c.var.audit.carrier({ parentEventId: eventId });
  await refunds.add('refund', { bookingId: id, carrier });
  return c.json({ ok: true });
});`;

const workerSample = `// Worker
import { jobAudit } from '@logbird/sdk/integration';

new Worker('refunds', async (job) => {
  const audit = jobAudit({ client, job, carrier: job.data.carrier });
  // ...refund the payment
  audit('payment.refunded', {
    targets: [{ type: 'booking', id: job.data.bookingId }],
  });
  await audit.pending();
});`;

/** The self-host quickstart beside the open-source section: the commands once the source is public, a waitlist panel before. */
export type HomeQuickstart =
  | { kind: 'public'; title: string; code: string; next: Marked }
  | { kind: 'private'; eyebrow: string; title: string; body: Marked; cta: Cta };

export function homeContent(site: SiteState) {
  const shared = sharedContent(site);
  return {
    hero: {
      eyebrow: 'Open-source audit logs · MIT',
      title: 'Retrace every step.',
      lead: 'Logbird is the audit log for your product. Send who-did-what events over HTTP or the SDK. Search them, follow any user, customer account or record, and run it on your own servers.',
      primaryCta: { label: shared.accessCta, to: '/contact' } satisfies Cta,
      status: byRepo(site, {
        public: shared.cloudStatusLine,
        private: `Source on GitHub — coming soon. ${shared.cloudStatusLine}`,
      }),
      /** Shown only when the console takes sign-ins; rendered as "Already invited? Sign in." */
      signIn: site.signInUrl ? { prompt: 'Already invited?', label: 'Sign in', href: site.signInUrl } : undefined,
      sample: { title: 'Send your first event', code: curl, caption: "That's a valid event. Only `action` is required." },
    },
    explorer: {
      label: 'The Logbird explorer',
      frameLabel: 'Explorer',
      caption: 'The explorer: search, facets, a histogram you can zoom, and every event in a dense table.',
    },
    developers: {
      eyebrow: 'For developers',
      title: 'One call per action. No schema to migrate.',
      lead: 'Only an action string is required, and each event must fit the ingest limits. Add the fields you have: who did it, in which customer account, to which records, what changed. Logbird lifts the fields it knows into their own columns. Custom top-level fields and anything under metadata are searchable as attributes within the indexing limits, and the full parsed event is available as JSON. Recommended fields are optional: an event is never rejected for missing them.',
      /** Each body continues its title's sentence, so it starts with its own space or colon. */
      items: [
        { title: 'TypeScript SDK', body: ' with batching, retries and an explicit flush and shutdown.' },
        { title: 'Middleware', body: ' for Hono, TanStack Start and Nuxt; a Vue read composable.' },
        { title: '`jobAudit` for queue workers', body: ": the job keeps the original actor and joins the request's operation." },
        {
          title: 'A conformance score',
          body: ' on every event: the share of nine recommended checks it passes. The setup page shows which fields your events miss.',
        },
      ] satisfies Item[],
      cta: { label: 'Read the developer guide', to: '/developers' } satisfies Cta,
      code: [
        { id: 'route', label: 'Route', code: routeSample },
        { id: 'worker', label: 'Worker', code: workerSample },
      ],
      codeCaption: 'The actor is Lina on both events. The worker only carried it out.',
    },
    operators: {
      eyebrow: 'For support, operations and compliance',
      title: 'Answer "what happened in this account?" in one search.',
      lead: 'The console is built for the people who get the question: support, operators, and whoever answers the auditor. Search every event, open a customer account or a single record, and see the before and after values you send for the first 256 changes of each event.',
      screenshot: {
        label: 'Event detail',
        caption:
          'An event in detail: who asked, what did the work, whose account, which records, and the before and after values sent for each change (the first 256 per event).',
      },
      features: {
        search: { title: 'Search', body: '`actor:usr_42 action:booking.* outcome:failure`, or a guarded SQL `WHERE` expression.' },
        entities: { title: 'Entity pages', body: 'Actors, tenants, executors and records get their own pages and timelines.' },
        operations: {
          title: 'Operation trees',
          body: 'The events that share an operation id, from the request to the jobs it spawned, as one tree.',
        },
        impersonation: { title: 'Impersonation', body: 'When support acts for a customer, the event records who acted for whom.' },
        retention: { title: 'Retention', body: 'Per project, from 7 days to 10 years. Expired events are permanently deleted.' },
      } satisfies Record<string, Item>,
      cta: { label: 'Take the product tour', to: '/product' } satisfies Cta,
    },
    howItWorks: {
      eyebrow: 'How it works',
      title: 'From one curl to a searchable history.',
      steps: [
        { title: 'Create a project', body: "Copy its ingest key. It's shown once and stored only as a hash." },
        { title: 'Send events', body: 'Over HTTP or the SDK: one event, or up to 1000 per request.', detail: 'POST /v1/events' },
        {
          title: 'Logbird stores them',
          body: 'On `202`, `ids` lists the events written to ClickHouse, by this request or an earlier identical one, and `rejected` names the entries that failed.',
          detail: '202 Accepted',
        },
        {
          title: 'Search, follow, keep',
          body: 'Use the console, or read events from your own backend with a read key. Expired events are deleted every hour.',
        },
      ] satisfies (Item & { detail?: string })[],
      /** Architecture at a glance: the README's mermaid diagram as accessible HTML (components/marketing/steps.tsx). */
      architecture: {
        flow: [
          { name: 'Your product', role: 'SDK or HTTP, ingest key' },
          { name: 'Logbird API', role: 'Validates, answers 202 after the write' },
          { name: 'ClickHouse', role: 'Events, rollups, entity pages' },
          { name: 'Console and read API', role: 'Your team, and your own backend' },
        ],
        /** Each detail continues its name, so it starts with its own separator. */
        stores: [
          { name: 'Postgres', role: ' · workspaces, projects, members, hashed keys' },
          { name: 'Retention worker', role: ' · deletes expired events every hour, on Redis or Dragonfly' },
        ],
        caption:
          'Your product sends events to the Logbird API, which writes them to ClickHouse. The console and the read API read from ClickHouse. Postgres stores workspaces, projects and hashed keys. A retention worker deletes expired events every hour.',
      },
    },
    envelope: {
      eyebrow: 'The envelope at a glance',
      title: 'Who caused it, what did the work, what changed.',
      lead: "Only action is required. These fields fill the console's pages and make search precise.",
      cta: { label: 'Read the envelope guide', to: '/developers' } satisfies Cta,
      frameTitle: 'POST /v1/events',
      /** The recommended envelope; each annotated key's line is marked in the JSON. */
      lines: [
        { text: '{' },
        { text: '  "action": "booking.cancelled",', key: 'action' },
        { text: '  "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad" },', key: 'actor' },
        { text: '  "executor": { "type": "api", "id": "api-server" },', key: 'executor' },
        { text: '  "tenant": { "id": "biz_7", "name": "Azure Hotels" },', key: 'tenant' },
        { text: '  "targets": [{ "type": "booking", "id": "bk_1042" }],', key: 'targets' },
        { text: '  "changes": [{ "field": "status", "before": "confirmed", "after": "cancelled" }],', key: 'changes' },
        { text: '  "context": { "operationId": "op_cancel_bk_1042" }', key: 'operationId' },
        { text: '}' },
      ] as { text: string; key?: string }[],
      /** The annotation list repeats the key, so the pairing reads without colour. */
      notes: [
        { key: 'action', text: 'What happened. The only required field.', required: true },
        { key: 'actor', text: 'Who asked.' },
        { key: 'executor', text: 'What did the work, and on which attempt.' },
        { key: 'tenant', text: 'Whose account.' },
        { key: 'targets', text: 'Which records.' },
        { key: 'changes', text: 'Before and after. Never secrets.' },
        { key: 'operationId', text: 'Ties a request to the jobs it started.' },
      ] as { key: string; text: string; required?: boolean }[],
      requiredBadge: 'required',
    },
    openSource: {
      eyebrow: 'Open source',
      title: 'MIT-licensed. Runs with Docker Compose.',
      lead: byRepo(site, {
        public:
          'The whole product is in one repository: the API, the console, the retention worker, the SDK and the integrations. Self-hosting runs on your server, from the published, versioned images once a release exists, so your events stay on your infrastructure.',
        private:
          'The whole product is in one repository: the API, the console, the retention worker, the SDK and the integrations. Self-hosting runs it on your server, so your events stay on your infrastructure.',
      }),
      bullets: [
        'Bundled Docker Compose, Coolify, or your own Postgres, ClickHouse and Redis.',
        'Automatic HTTPS with Caddy, or any reverse proxy you already run.',
        byRepo(site, { public: 'Source on GitHub, under the MIT licence.', private: 'Source on GitHub — coming soon.' }),
      ],
      repositoryCta: { label: "What's in the repository", to: '/open-source' } satisfies Cta,
      quickstart: byRepo<HomeQuickstart>(site, {
        public: {
          kind: 'public',
          title: site.selfHostVersion ? `Self-host ${site.selfHostVersion}` : 'Self-host from source',
          code: selfHostQuickstart,
          next: 'Then open `http://localhost:4600`, sign in with the emailed code and create a project. Configure SMTP first, or enable sign-in codes in the server log.',
        },
        private: {
          kind: 'private',
          eyebrow: 'Self-host quickstart',
          title: 'Available when the repository opens.',
          body: "On one VM: clone, generate secrets, configure SMTP, pull the images, then `docker compose up -d --no-build`. We'll publish the commands here the day the source is public.",
          cta: { label: 'Tell me when it opens', to: '/contact', search: { interest: 'self-host' } },
        },
      }),
    },
    guarantees: {
      eyebrow: 'Guarantees and limits',
      title: 'What Logbird promises, and where the promise ends.',
      items: [
        {
          promise: 'A `202` lists accepted event IDs in `ids` and rejected events in `rejected`.',
          limit:
            'Delivery is at least once when the client retries unsettled events, as the SDK does. An exact retry with the same valid, non-blank string `id` is stored once while the project retains the event; changed content under that id is rejected with `duplicate_id_conflict`. An event sent without an id gets a new one on every retry.',
        },
        {
          promise: 'The SDK batches and retries for you.',
          limit: 'Its queue is in memory: a crash before the server acknowledges can lose pending events.',
        },
        {
          promise: 'Only an `action` string is required, and each event must fit the ingest limits.',
          limit:
            'Each event is checked on its own: rejected events are listed in `rejected` with a reason. On `202`, the rest of the batch is accepted. When a `503` lists the unsettled events, retry only those; otherwise retry the whole batch with the same ids.',
        },
        { promise: 'Retention deletes expired events for good.', limit: "There's no archive and no undo." },
        {
          promise: 'Import history by sending events with their original `occurredAt`, up to 3650 days back.',
          limit:
            "An older `occurredAt` is stored at receive time with a warning, and project retention still applies to imports. Logbird doesn't rebuild history from your database.",
        },
      ],
      cta: { label: 'Read how Logbird handles data', to: '/security' } satisfies Cta,
    },
    closingNote: DESIGN_PARTNER_LINE,
  };
}

export type HomeContent = ReturnType<typeof homeContent>;
export const home: HomeContent = homeContent(SITE);
