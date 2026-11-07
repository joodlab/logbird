import { createFileRoute } from '@tanstack/react-router';
import { ButtonLink } from '../components/marketing/button-link';
import { SiteCode, SiteCodeTabs } from '../components/marketing/code';
import { CtaBand } from '../components/marketing/cta-band';
import { FeatureRow } from '../components/marketing/feature-row';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/developers')({ head: () => pageHead('/developers'), component: DevelopersPage });

// Copy: marketing/copy/developers.md. Every sample is checked against packages/sdk and packages/integrations READMEs.
const quickstart = `import { Logbird } from '@logbird/sdk';

const client = new Logbird({
  endpoint: process.env.LOGBIRD_ENDPOINT, // your Logbird origin, e.g. https://audit.example.com
  apiKey: process.env.LOGBIRD_INGEST_KEY, // lb_ingest_...
  enabled: Boolean(process.env.LOGBIRD_INGEST_KEY), // off locally when no key is set
  defaults: { environment: 'production' },
  onError: (error) => console.error(error.message), // permanent rejections and background failures
  onDrop: (event) => console.warn('audit event dropped', event.action), // each rejected or discarded event
});

client.track({
  action: 'booking.cancelled',
  actor: { type: 'user', id: 'usr_42', name: 'Lina Haddad' },
  tenant: { id: 'biz_7', name: 'Azure Hotels' },
  targets: [{ type: 'booking', id: 'bk_1042', name: 'Booking #1042' }],
  changes: [{ field: 'status', before: 'confirmed', after: 'cancelled' }],
});

// flush() rejects only when retryable delivery (network, 429, 5xx) runs out of retries; the batch stays
// queued for the next flush. Permanent rejections don't reject: they arrive through onError and onDrop.
await client.flush().catch((error) => console.error('audit delivery pending', error));
await client.shutdown(); // on exit: stop accepting events and drain the queue`;

const http = `curl https://audit.example.com/v1/events \\
  -H "Authorization: Bearer $LOGBIRD_INGEST_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '[{"action":"booking.cancelled","actor":{"type":"user","id":"usr_42"}},
       {"action":"payment.refunded","actor":{"type":"user","id":"usr_42"}}]'`;

const smallest = `curl https://audit.example.com/v1/events \\
  -H "Authorization: Bearer $LOGBIRD_INGEST_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"action":"booking.cancelled"}'`;

const worked = `[
  {
    "id": "evt_cancel_bk_1042",
    "action": "booking.cancelled",
    "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad" },
    "executor": { "type": "api", "id": "api-server" },
    "tenant": { "id": "biz_7", "name": "Azure Hotels" },
    "targets": [{ "type": "booking", "id": "bk_1042" }],
    "changes": [{ "field": "status", "before": "confirmed", "after": "cancelled" }],
    "context": { "operationId": "op_cancel_bk_1042" }
  },
  {
    "action": "payment.refunded",
    "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad" },
    "executor": { "type": "worker", "id": "refunds-worker", "jobId": "job_981", "attempt": 2 },
    "tenant": { "id": "biz_7", "name": "Azure Hotels" },
    "targets": [{ "type": "payment", "id": "pay_77" }, { "type": "booking", "id": "bk_1042" }],
    "context": { "operationId": "op_cancel_bk_1042", "parentEventId": "evt_cancel_bk_1042" }
  }
]`;

const hono = `import { Hono } from 'hono';
import { Logbird } from '@logbird/sdk';
import { logbird, type AuditVariables } from '@logbird/hono';

type User = { id: string; name: string };
const client = new Logbird({
  endpoint: process.env.LOGBIRD_ENDPOINT,
  apiKey: process.env.LOGBIRD_INGEST_KEY,
  onError: console.error,
});
const capture = logbird({
  client,
  actor: (c) => {
    const user = c.get('user') as User | undefined; // set by your auth middleware
    return user ? { type: 'user', id: user.id, name: user.name } : undefined;
  },
  autoTrack: {}, // also records POST, PUT, PATCH and DELETE requests automatically
});

const app = new Hono<{ Variables: AuditVariables & { user?: User } }>();
app.use(capture);
app.post('/records', (c) => {
  c.var.audit('record.created', { targets: [{ type: 'record', id: 'rec_123' }] });
  return c.json({ ok: true });
});
// In your shutdown handler: await capture.shutdown();`;

const workers = `// In the request handler
const eventId = c.var.audit('booking.cancelled', { targets: [{ type: 'booking', id: 'bk_1042' }] });
const carrier = await c.var.audit.carrier({ parentEventId: eventId });
await refunds.add('refund', { bookingId: 'bk_1042', carrier });

// In the worker
import { jobAudit } from '@logbird/sdk/integration';

new Worker('refunds', async (job) => {
  const audit = jobAudit({ client, job, carrier: job.data.carrier });
  // ...refund the payment
  audit('payment.refunded', { targets: [{ type: 'booking', id: job.data.bookingId }] });
  await audit.pending();
});`;

const read = `import { readAuditTrail, trailQuery } from '@logbird/sdk/read';

// Server only. First check that the signed-in user may see this booking.
const page = await readAuditTrail(
  { endpoint: process.env.LOGBIRD_ENDPOINT!, readKey: process.env.LOGBIRD_READ_KEY! },
  trailQuery({
    target: { type: 'booking', id: 'bk_1042' },
    tenant: 'biz_7',
    range: { from: '2026-01-01T00:00:00Z', to: new Date().toISOString() },
  }),
);
// page.data: events; page.nextCursor: pass back as \`cursor\` for the next page`;

const envelopeRows: [string, string, string][] = [
  ['actor', 'Who caused it', '{ type: "user", id: "usr_42", name: "Lina Haddad" }'],
  ['executor', 'What did the work, and on which try', '{ type: "worker", id: "refunds-worker", jobId: "job_981", attempt: 2 }'],
  ['impersonator', 'Which staff member acted for the actor', '{ id: "usr_1", name: "Support agent" }'],
  ['tenant', 'Whose account', '{ id: "biz_7", name: "Azure Hotels" }'],
  ['targets', 'Which records', '[{ type: "booking", id: "bk_1042" }]'],
  ['changes', 'What changed', '[{ field: "status", before: "confirmed", after: "cancelled" }]'],
  ['context.operationId, context.parentEventId', 'Which unit of work, and what caused this event', 'op_cancel_bk_1042'],
];

const limits: [string, string][] = [
  ['Events per request', '1 to 1000'],
  ['Request size', '5 MB'],
  ['Event size', '256 KB'],
  ['Attributes per event', 'Up to 256 indexed, 6 levels deep, the first 2 KiB of each value'],
  ['occurredAt', 'ISO-8601 or epoch milliseconds, from 3650 days ago to 24 hours ahead'],
  ['Ingest rate (default, per project)', '3000 requests a minute'],
  ['Read rate (default, per project)', '1200 requests a minute'],
];

const toc = [
  ['quickstart', 'Quickstart'],
  ['http', 'HTTP'],
  ['envelope', 'Envelope'],
  ['integrations', 'Integrations'],
  ['workers', 'Workers'],
  ['delivery', 'Delivery'],
  ['limits', 'Limits'],
  ['read-api', 'Read API'],
  ['reference', 'API reference'],
] as const;

function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="flex flex-col gap-3 text-sm leading-relaxed">
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static copy, never reordered
        <li className="flex gap-3" key={index}>
          <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
          <span className="text-muted-foreground">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function OperationTree() {
  const node = 'panel flex flex-col gap-1 px-4 py-3';
  return (
    <figure className="flex flex-col gap-3">
      <div className="rounded-2xl border border-dashed p-4 sm:p-5">
        <p className="mb-3 font-mono text-muted-foreground text-xs">operation · op_cancel_bk_1042</p>
        <div className={node}>
          <span className="font-mono text-sm">booking.cancelled</span>
          <span className="text-muted-foreground text-xs">API server · Lina Haddad</span>
        </div>
        <div className="ms-5 border-s ps-5 pt-3">
          <div className={`${node} border-brand/60`}>
            <span className="font-mono text-sm">payment.refunded</span>
            <span className="text-muted-foreground text-xs">Refunds worker · attempt 2 · Lina Haddad</span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {['Actors: Lina Haddad', 'Tenants: Azure Hotels', 'Records: booking:bk_1042'].map((chip) => (
          <span className="rounded-full border bg-background px-3 py-1 text-muted-foreground" key={chip}>
            {chip}
          </span>
        ))}
      </div>
      <figcaption className="text-muted-foreground text-sm">
        Both events land on Lina's page, Azure Hotels' page and booking bk_1042's page. The operation page shows the refund nested under the
        cancellation.
      </figcaption>
    </figure>
  );
}

function DevelopersPage() {
  return (
    <>
      <PageHero
        actions={
          <>
            <ButtonLink href="#quickstart" size="lg">
              Quickstart
            </ButtonLink>
            <ButtonLink size="lg" to="/self-hosting" variant="outline">
              Self-host a server
            </ButtonLink>
          </>
        }
        aside={<SiteCode code={smallest} language="bash" title="The smallest event" />}
        eyebrow="Developers"
        lead={
          <>
            Send events over HTTP or with the TypeScript SDK. Only <code>action</code> is required, so you can start with one line and fill in the
            envelope as you go. This page covers the SDK, the envelope, workers, delivery guarantees and limits.
          </>
        }
        title="Add an audit log in an afternoon. Keep it for years."
      />

      <nav aria-label="On this page" className="container-site flex flex-wrap gap-2 pt-10">
        {toc.map(([id, label]) => (
          <a
            className="inline-flex min-h-9 items-center rounded-full border bg-background px-3.5 text-muted-foreground text-sm hover:text-foreground"
            href={`#${id}`}
            key={id}
          >
            {label}
          </a>
        ))}
      </nav>

      <FeatureRow
        bullets={[
          <>
            <code>track(event)</code> never throws and never waits for the network.
          </>,
          <>
            <code>flush()</code> and <code>shutdown()</code> reject when retryable delivery (network, <code>429</code>, <code>5xx</code>) runs out of
            retries, and the batch stays queued. Permanent rejections arrive through <code>onError</code> and <code>onDrop</code> instead.
          </>,
          <>
            Call <code>shutdown()</code> from your host's own exit hook. The SDK installs no process handlers.
          </>,
          'Keep ingest keys on the server. Never ship one in a browser bundle.',
        ]}
        eyebrow="SDK quickstart"
        id="quickstart"
        limit={
          <>
            <strong className="font-medium text-foreground">Redaction:</strong> <code>beforeSend: redact()</code> deep-copies each event and replaces
            passwords, tokens, API keys, cookies and similar keys with <code>[redacted]</code> before sending. Add your own patterns for email or
            phone numbers; the default list covers secrets, not all personal data.
          </>
        }
        title="Install, create a client, track an event."
        visual={
          <div className="flex flex-col gap-3">
            <SiteCode code="npm install @logbird/sdk" language="bash" title="After the first npm release" />
            <SiteCode code={quickstart} language="ts" title="server.ts" />
            <p className="text-muted-foreground text-sm">The packages publish to npm with the first release, when the repository opens.</p>
          </div>
        }
      >
        The SDK has no dependencies. It runs on Node 22+ and in modern runtimes with Fetch and Web Crypto. It batches events, retries failures and
        gives each event an id and a timestamp if you don't.
      </FeatureRow>

      <FeatureRow
        eyebrow="No SDK? Use HTTP."
        id="http"
        reverse
        title="One request, one to a thousand events."
        visual={<SiteCode code={http} language="bash" title="curl" />}
      >
        <code>POST /v1/events</code> accepts one event, a JSON array, or <code>{'{ "events": [...] }'}</code>. Authenticate with an ingest key. A{' '}
        <code>202</code> means ClickHouse has the rows.
      </FeatureRow>

      <Section compact id="envelope" labelledBy="envelope-title" tone="sunken">
        <SectionHeader
          eyebrow="The envelope"
          id="envelope-title"
          lead="Logbird stores anything you send. These recommended fields become indexed columns, each one fills a page in the console, and the conformance score tells you how many of them an event has."
          title="Six fields that make an audit log useful."
        />
        <div className="panel mt-10 overflow-hidden">
          <table className="table-site">
            <caption className="sr-only">Recommended envelope fields</caption>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Answers</th>
                <th className="hidden md:table-cell" scope="col">
                  Example
                </th>
              </tr>
            </thead>
            <tbody>
              {envelopeRows.map(([field, answers, example]) => (
                <tr key={field}>
                  <th className="font-mono text-sm" scope="row">
                    {field}
                  </th>
                  <td>
                    {answers}
                    <code className="mt-1 block break-all font-mono text-muted-foreground text-xs md:hidden">{example}</code>
                  </td>
                  <td className="hidden font-mono text-muted-foreground text-xs md:table-cell">{example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-12 grid gap-10 lg:grid-cols-2">
          <div className="flex flex-col gap-6">
            <h3 className="h3">The rules</h3>
            <Bullets
              items={[
                <>
                  <strong className="font-medium text-foreground">The actor is who asked; the executor is what did the work.</strong> A refund Lina
                  requested and a queue worker carried out has <code>actor = Lina</code>, <code>executor = refunds-worker</code>.
                </>,
                <>
                  <strong className="font-medium text-foreground">Scheduled jobs nobody triggered</strong> use <code>actor.type: "system"</code>.
                </>,
                <>
                  <strong className="font-medium text-foreground">When support acts for a customer,</strong> the customer stays the actor and the
                  staff member goes in <code>impersonator</code>.
                </>,
                <>
                  <strong className="font-medium text-foreground">Never send secrets in </strong>
                  <code>changes</code>. Send <code>"[redacted]"</code> to record that a secret changed.
                </>,
                <>
                  <strong className="font-medium text-foreground">Everything else is kept.</strong> Custom top-level keys and anything under{' '}
                  <code>metadata</code> become searchable attributes, for example <code>metadata.channel:whatsapp</code>.
                </>,
              ]}
            />
            <OperationTree />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <h3 className="h3">Worked example</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Lina cancels booking #1042. The API records the cancellation and queues a refund. The refund worker fails once, then succeeds on attempt
              2.
            </p>
            <SiteCode code={worked} language="json" title="Two events, one operation" />
          </div>
        </div>
      </Section>

      <FeatureRow
        eyebrow="Integrations"
        id="integrations"
        limit="Express, Next.js, Laravel and Django are planned. We'll add them when we use those stacks ourselves."
        title="Middleware for the stacks we run."
        visual={<SiteCodeTabs tabs={[{ id: 'hono', label: 'Hono', code: hono, language: 'ts' }]} />}
      >
        <p>
          First-party packages for Hono, TanStack Start, Vue and Nuxt. On the server, the Hono, TanStack Start and Nuxt packages give you an{' '}
          <code>audit(action, partialEvent)</code> function per request. It resolves the actor, tenant, request id and operation id when you call it,
          so identity set by a per-route auth guard is still picked up. <code>audit()</code> returns the event id straight away and never waits for
          delivery.
        </p>
        <dl className="mt-5 grid gap-4 text-sm">
          <div>
            <dt className="font-medium text-foreground">
              TanStack Start <code>@logbird/tanstack-start</code>
            </dt>
            <dd>
              Request middleware plus function middleware; call <code>context.audit(...)</code> inside server functions. Includes{' '}
              <code>readAuditTrail</code> and <code>trailQuery</code> for history routes.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">
              Vue <code>@logbird/vue</code>
            </dt>
            <dd>
              <code>useAuditTrail</code> and a headless <code>AuditTimeline</code> that read history through your authenticated backend, with loading,
              error, refresh and load-more states.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">
              Nuxt <code>@logbird/nuxt</code>
            </dt>
            <dd>
              A Nitro plugin adds <code>event.context.audit</code>. A built-in history route denies every request until your{' '}
              <code>authorize(event, query)</code> hook returns a trusted query.
            </dd>
          </div>
        </dl>
      </FeatureRow>

      <FeatureRow
        eyebrow="Workers and jobs"
        id="workers"
        limit="A carrier is trusted internal data for correlation, not proof of identity."
        reverse
        title="Keep the actor when the work moves to a queue."
        visual={<SiteCode code={workers} language="ts" title="Request → job" />}
      >
        <code>audit.carrier()</code> packs the operation id, request id, parent event, actor and tenant into plain JSON you put on the job. On the
        worker, <code>jobAudit()</code> turns it back into an <code>audit</code> function. The executor is filled from the job's queue, id and attempt
        number. There's no BullMQ dependency; any job object with <code>id</code>, <code>name</code>, <code>queueName</code> and{' '}
        <code>attemptsMade</code> works.
      </FeatureRow>

      <Section compact id="delivery" labelledBy="delivery-title" tone="sunken">
        <div className="grid gap-12 lg:grid-cols-2">
          <div className="flex flex-col gap-8">
            <SectionHeader
              eyebrow="Delivery semantics"
              id="delivery-title"
              title={
                <>
                  What happens between <code className="font-mono text-[0.8em] tracking-normal">track()</code> and the{' '}
                  <code className="font-mono text-[0.8em] tracking-normal">202</code>.
                </>
              }
            />
            <Bullets
              items={[
                <>
                  <strong className="font-medium text-foreground">Batched.</strong> Events go in batches of up to 100, or every second, whichever
                  comes first.
                </>,
                <>
                  <strong className="font-medium text-foreground">Retried.</strong> Rate limits (<code>429</code>), server errors and network failures
                  are retried with exponential backoff and jitter, up to 5 times. A numeric <code>Retry-After</code> is honoured.
                </>,
                <>
                  <strong className="font-medium text-foreground">Acknowledged after storage.</strong> The server answers <code>202</code> only once
                  ClickHouse has the rows.
                </>,
                <>
                  <strong className="font-medium text-foreground">At least once.</strong> A retry after a lost response can store an event twice.
                  Counts may include duplicates.
                </>,
                <>
                  <strong className="font-medium text-foreground">Bounded under outage.</strong> The queue holds up to 10,000 events by default. When
                  it's full, <code>dropPolicy: 'oldest'</code> (the default) or <code>'newest'</code> decides what goes, and <code>onDrop</code>{' '}
                  reports each event dropped.
                </>,
                <>
                  <strong className="font-medium text-foreground">In memory.</strong> A crash before the server acknowledges can lose pending events.
                  Call <code>shutdown()</code> on exit.
                </>,
                <>
                  <strong className="font-medium text-foreground">Partial batches.</strong> Events without an <code>action</code> are rejected one by
                  one, and the rest are stored. Permanent errors other than <code>429</code> drop the batch and report it through <code>onError</code>{' '}
                  and <code>onDrop</code>, without rejecting <code>flush()</code>.
                </>,
              ]}
            />
          </div>
          <div className="flex flex-col gap-8" id="limits">
            <SectionHeader eyebrow="Ingest limits" id="limits-title" title="The numbers to design around." />
            <div className="panel overflow-hidden">
              <table className="table-site">
                <caption className="sr-only">Ingest and read limits</caption>
                <tbody>
                  {limits.map(([label, value]) => (
                    <tr key={label}>
                      <th scope="row">{label === 'occurredAt' ? <code>occurredAt</code> : label}</th>
                      <td className="text-muted-foreground">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Bullets
              items={[
                'Rate limits are shared by all keys of the same kind in a project, across replicas. Self-hosters can change them.',
                <>
                  Responses carry <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and <code>RateLimit-Reset</code>. A <code>429</code>{' '}
                  includes <code>Retry-After</code>.
                </>,
                <>
                  An unusable <code>occurredAt</code> never drops the event. It is stored at receive time, the original value is kept, and the
                  response lists a warning.
                </>,
              ]}
            />
          </div>
        </div>
      </Section>

      <FeatureRow
        eyebrow="Read API"
        id="read-api"
        limit="A read key can read the whole project. A query filter is not authorization: your backend must check the tenant and record on every request, including each next page. The read API accepts the query language, not SQL mode. Tenant-scoped read tokens are on the roadmap."
        title="Read your own history back."
        visual={<SiteCode code={read} language="ts" title="Your backend" />}
      >
        <code>GET /v1/events</code> with a read key returns matching events, newest first, up to 200 per page, with a <code>nextCursor</code> for the
        next page. <code>GET /v1/events/:eventId</code> returns one event. Without <code>from</code> and <code>to</code>, the range is the last 24
        hours.
      </FeatureRow>

      <Section compact id="reference" labelledBy="reference-title">
        <div className="panel flex flex-col gap-4 p-8 md:p-10">
          <p className="eyebrow">API reference</p>
          <h2 className="h2" id="reference-title">
            Your server documents itself.
          </h2>
          <p className="lead max-w-3xl">
            Every Logbird API server serves its OpenAPI document at <code>/openapi.json</code> and an interactive reference at <code>/docs</code>, so
            the reference always matches the version you run. In the bundled Compose setup the API server listens only on the private network, and the
            public origin forwards only <code>/api</code>, <code>/v1</code> and the health checks. Open the reference from inside that network, or at{' '}
            <code>localhost:4601</code> when you run from source.
          </p>
          <div>
            <ButtonLink to="/self-hosting" variant="outline">
              Self-host a server
            </ButtonLink>
          </div>
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
