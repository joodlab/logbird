import { DESIGN_PARTNER_LINE } from '../lib/copy-flags';
import { sharedContent } from './shared';
import { byCloud, byRepo, type Cta, type Item, type Marked, SITE, type SiteState } from './site';

/**
 * The home page's words (routes/index.tsx), built around the two jobs people pay for: an audit log their customers can
 * see, and evidence for their auditors. Brief, with the source of every claim: marketing/copy/home.md. Every claim is
 * true for master; numbers appear only when measured and sourced.
 */

/** Head metadata, read by lib/site-map.ts. The description stays within 155 characters in every state. */
export function homeMetaFor(site: SiteState) {
  return {
    title: 'Home',
    description: `The audit log your customers ask for, and the evidence your auditors ask for. ${byRepo(site, {
      public: byCloud(site, {
        open: 'Open source: self-host it, or ask for early access to Logbird Cloud.',
        closed: 'Open source: self-host it, or join the Logbird Cloud waitlist.',
      }),
      private: 'Open source and MIT-licensed. Join the waitlist to hear when it opens.',
    })}`,
  };
}
export const homeMeta = homeMetaFor(SITE);

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

/** A promise and where it ends: one row of a limits table (components/marketing/guarantees.tsx). */
export interface Limit {
  promise: Marked;
  limit: Marked;
}

export function homeContent(site: SiteState) {
  const shared = sharedContent(site);
  const hosting = byRepo(site, {
    public: byCloud(site, {
      open: 'run it on your own servers, or ask for early access to Logbird Cloud.',
      closed: 'run it on your own servers, or join the waitlist for Logbird Cloud.',
    }),
    private: byCloud(site, {
      open: 'run it on your own servers once the source opens, or ask for early access to Logbird Cloud.',
      closed: 'run it on your own servers once the source opens, or join the waitlist for Logbird Cloud.',
    }),
  });
  return {
    hero: {
      /** The brand line, kept near the wordmark and in the closing band. */
      eyebrow: 'Retrace every step.',
      title: 'The audit log your customers ask for, and the evidence your auditors ask for.',
      lead: `Send one event per action over HTTP or the TypeScript SDK. Show each customer account its own history in your product, search everything in the console, and export it complete when an auditor asks. MIT-licensed: ${hosting}`,
      primaryCta: { label: shared.accessCta, to: '/contact' } satisfies Cta,
      status: byRepo(site, {
        public: shared.cloudStatusLine,
        private: `Source on GitHub — coming soon. ${shared.cloudStatusLine}`,
      }),
      /** Shown only when the console takes sign-ins; rendered as "Already invited? Sign in." */
      signIn: site.signInUrl ? { prompt: 'Already invited?', label: 'Sign in', href: site.signInUrl } : undefined,
      /** Shown only while the repository is public. */
      github: site.githubUrl ? { label: 'Source on GitHub', href: site.githubUrl } : undefined,
      sample: { title: 'Send your first event', code: curl, caption: "That's a valid event. Only `action` is required." },
    },
    explorer: {
      label: 'The Logbird explorer',
      frameLabel: 'Explorer',
      caption: 'The explorer: search, facets, a histogram you can zoom, and every event in a dense table.',
    },
    customers: {
      eyebrow: 'Customer-facing audit logs',
      title: 'Show each customer their own history.',
      lead: "Your customers' admins want to see who did what in their account. Send each event with the customer account it belongs to (`tenant`), and your product can show every account its own trail.",
      /** Today: reads go through your backend, which authorizes each customer account. */
      now: {
        points: [
          {
            title: 'Read from your backend',
            body: 'Your server reads the trail with a read key and the query language, for example `tenant:biz_7`.',
          },
          {
            title: 'Authorize in one place',
            body: "The Nuxt integration's proxy denies by default: your `authorize()` decides which customer account a user may see and returns the only query that is forwarded.",
          },
          {
            title: 'Render it in your product',
            body: "Vue's `useAuditTrail` loads the events page by page, and a headless `AuditTimeline` renders them with your own markup.",
          },
        ] satisfies Item[],
        limit: 'A read key reads the whole project, so your backend must decide which customer account each user may see.',
      },
      /** After the production proof of scoped read access (SiteState.scopedReadLive). */
      scoped: {
        points: [
          {
            title: 'Viewer tokens',
            body: 'Your server mints a token for one customer account and hands it to the browser. It expires after 15 minutes by default, one hour at most.',
          },
          {
            title: 'Enforced by Logbird',
            body: 'The scope applies outside every query, on search, event detail, counts and export. Nothing in the query can widen it.',
          },
          {
            title: 'Scoped server keys',
            body: 'A scoped read key can only ever read one customer account, optionally narrowed to one record or to actions with given prefixes.',
          },
        ] satisfies Item[],
        limit:
          "One customer account per scope, matched on the id Logbird stored. ClickHouse enforces the customer account as well only when the restricted query user is configured; otherwise Logbird's query builders are the single layer.",
      },
      limitLabel: 'The limit',
      screenshot: {
        label: 'Customer account',
        caption:
          "A customer account's page in the console: its events, activity, outcomes, top actions and the people, workers and records involved.",
      },
      cta: { label: 'Read the integration guide', to: '/developers', hash: 'integrations' } satisfies Cta,
    },
    evidence: {
      eyebrow: 'Compliance evidence',
      title: 'Answer the auditor with evidence.',
      lead: "When an auditor or a customer's security team asks what happened, show them the events: who acted, for whom, on which records, and what changed.",
      headers: { promise: 'What you can show', limit: 'The limit' },
      rows: [
        {
          promise:
            'Each event can name the actor, the staff member acting for them (`impersonator`), the customer account, the records, and the before and after values of up to 256 changes.',
          limit: "Logbird records what your code sends. It can't add an actor or a change that your event leaves out.",
        },
        {
          promise: 'Retention per project, from 7 days to 10 years. Expired events are permanently deleted every hour.',
          limit:
            'An owner or admin can shorten retention, and the deletion then starts immediately and is final. There is no retention lock or legal hold yet; it is on the roadmap.',
        },
        {
          promise:
            'The evidence export (`jsonl-evidence`) carries every matching event with its original payload. Its record keeps the filter, the fixed query clock, the SHA-256, the size and the row count, so a file can be matched to its record.',
          limit:
            "Matching the SHA-256 and size establishes that the file matches Logbird's output; it does not establish who saved it or when it reached a client's disk.",
        },
        {
          promise:
            'Workspace activity records what your team does in Logbird: project and retention changes, keys, members and roles, saved views, invite links, exports, sign-ins and ended sessions.',
          limit: "It doesn't record who searched or opened events.",
        },
      ] satisfies Limit[],
      screenshot: {
        label: 'Retention',
        caption: "A project's retention settings: the current window and the policies you can choose.",
      },
      cta: { label: 'Retention and workspace activity, in detail', to: '/security', hash: 'retention' } satisfies Cta,
    },
    operators: {
      eyebrow: 'Support investigations',
      title: 'Answer "what happened in this account?" in one search.',
      lead: 'Support and operations open a customer account or a single record and see its events in order, with the before and after values you send.',
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
      } satisfies Record<string, Item>,
      cta: { label: 'Take the product tour', to: '/product' } satisfies Cta,
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
      /** Other stacks, and the .NET package: in the repository, not on NuGet. No C# code or install command until it is. */
      otherStacks: {
        text: 'Not on TypeScript? Any language that can POST JSON over HTTP works. A .NET package is in the repository and not yet on NuGet:',
        /** The package folder while the repository is public; a note while it is private. */
        link: site.githubUrl ? { label: 'sdks/dotnet', href: `${site.githubUrl.replace(/\/+$/, '')}/tree/master/sdks/dotnet` } : undefined,
        privateNote: '`sdks/dotnet`, once the source opens.',
      },
      cta: { label: 'Read the developer guide', to: '/developers' } satisfies Cta,
      code: [
        { id: 'route', label: 'Route', code: routeSample },
        { id: 'worker', label: 'Worker', code: workerSample },
      ],
      codeCaption: 'The actor is Lina on both events. The worker only carried it out.',
    },
    hosting: {
      eyebrow: 'Self-host or Cloud',
      /** "…or ours" only as far as Logbird Cloud is open (README.md § Owner-gated copy, cloud-clause). */
      title: byRepo(site, {
        public: byCloud(site, {
          open: 'Run it on your servers, or on ours in early access.',
          closed: 'Run it on your servers today, or join the waitlist for ours.',
        }),
        private: byCloud(site, {
          open: 'Run it on ours in early access, or on yours once the source opens.',
          closed: 'Run it on your servers once the source opens, or on ours when Logbird Cloud opens.',
        }),
      }),
      selfHost: {
        title: 'Self-host',
        body: byRepo(site, {
          public:
            'Every feature, MIT-licensed. Docker Compose on one VM, Coolify, or your own Postgres, ClickHouse and Redis. Your events stay on your infrastructure.',
          private:
            'Every feature, MIT-licensed, once the source opens. Docker Compose on one VM, Coolify, or your own Postgres, ClickHouse and Redis. Your events stay on your infrastructure.',
        }),
        repositoryCta: { label: "What's in the repository", to: '/open-source' } satisfies Cta,
      },
      cloud: {
        title: 'Logbird Cloud',
        body: byCloud(site, {
          open: 'The same open-source codebase, and we run the servers, the upgrades and the backups. It is in early access: sign-ups are limited to invited teams for now.',
          closed:
            "The same open-source codebase, and we run the servers, the upgrades and the backups. It isn't open yet: join the waitlist to hear when it opens.",
        }),
        primaryCta: { label: shared.accessCta, to: '/contact' } satisfies Cta,
        moreCta: { label: 'About Logbird Cloud', to: '/cloud' } satisfies Cta,
      },
    },
    guarantees: {
      eyebrow: 'Guarantees and limits',
      title: 'What Logbird promises, and where the promise ends.',
      headers: { promise: 'We guarantee', limit: 'The limit' },
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
      ] satisfies Limit[],
      cta: { label: 'Read how Logbird handles data', to: '/security' } satisfies Cta,
    },
    closing: {
      /** The brand line above the shared closing band's heading. */
      eyebrow: 'Retrace every step.',
      note: DESIGN_PARTNER_LINE,
    },
    /**
     * Ingest-to-search time. Empty until T1 sends a measured value with its date and hardware: no time claim before
     * then. Numbers on this page are measured and sourced, or absent.
     */
    searchLatency: undefined as Marked | undefined,
  };
}

export type HomeContent = ReturnType<typeof homeContent>;
export const home: HomeContent = homeContent(SITE);
