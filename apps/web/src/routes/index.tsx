import { createFileRoute } from '@tanstack/react-router';
import { BoxesIcon, GitBranchIcon, SearchIcon, ShieldCheckIcon, TimerResetIcon, UserCogIcon } from 'lucide-react';
import { ButtonLink } from '../components/marketing/button-link';
import { SiteCode, SiteCodeTabs } from '../components/marketing/code';
import { CtaBand } from '../components/marketing/cta-band';
import { Envelope } from '../components/marketing/envelope';
import { ScreenshotFrame } from '../components/marketing/frame';
import { Guarantees } from '../components/marketing/guarantees';
import { LogStack } from '../components/marketing/log-stack';
import { Eyebrow, Feature, Section, SectionHeader } from '../components/marketing/section';
import { SelfHostCta } from '../components/marketing/self-host-cta';
import { Architecture, Steps } from '../components/marketing/steps';
import { GITHUB_PUBLIC, GITHUB_URL } from '../env';
import { DESIGN_PARTNER_LINE } from '../lib/copy-flags';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/')({ head: () => pageHead('/'), component: HomePage });

// Copy: marketing/copy/home.md. Change wording there first.
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
    changes: [{ field: 'status', before: 'confirmed', after: 'cancelled' }],
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

// Only rendered once the repository is public (GITHUB_PUBLIC); the URL comes from config.
const selfHost = `git clone ${GITHUB_URL}.git
cd logbird
sh scripts/selfhost-init.sh
docker compose up -d`;

function HomePage() {
  return (
    <>
      <Hero />

      <section aria-label="The Logbird explorer" className="pb-8">
        <div className="container-site">
          <ScreenshotFrame
            caption="The explorer: search, facets, a histogram you can zoom, and every event in a dense table."
            id="explorer"
            label="Explorer"
          />
        </div>
      </section>

      <Section id="developers" labelledBy="developers-title">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-start">
          <div className="flex flex-col gap-8">
            <SectionHeader
              eyebrow="For developers"
              id="developers-title"
              lead="Any JSON object with an action string is a valid event. Add the fields you have: who did it, in which customer account, to which records, what changed. Logbird lifts the fields it knows into indexed columns and keeps everything else as searchable attributes. Off-standard events are stored, never dropped."
              title="One call per action. No schema to migrate."
            />
            <ul className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
              <li className="text-sm leading-relaxed">
                <strong className="font-medium">TypeScript SDK</strong>
                <span className="text-muted-foreground"> with batching, retries and an explicit flush and shutdown.</span>
              </li>
              <li className="text-sm leading-relaxed">
                <strong className="font-medium">Middleware</strong>
                <span className="text-muted-foreground"> for Hono, TanStack Start and Nuxt; a Vue read composable.</span>
              </li>
              <li className="text-sm leading-relaxed">
                <strong className="font-medium">
                  <code>jobAudit</code> for queue workers
                </strong>
                <span className="text-muted-foreground">: the job keeps the original actor and joins the request's operation.</span>
              </li>
              <li className="text-sm leading-relaxed">
                <strong className="font-medium">A conformance score</strong>
                <span className="text-muted-foreground"> on every event shows which recommended fields you're missing.</span>
              </li>
            </ul>
            <div>
              <ButtonLink to="/developers" variant="outline">
                Read the developer guide
              </ButtonLink>
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <SiteCodeTabs
              tabs={[
                { id: 'route', label: 'Route', code: routeSample, language: 'ts' },
                { id: 'worker', label: 'Worker', code: workerSample, language: 'ts' },
              ]}
            />
            <p className="text-muted-foreground text-sm">The actor is Lina on both events. The worker only carried it out.</p>
          </div>
        </div>
      </Section>

      <Section id="operators" labelledBy="operators-title" tone="sunken">
        <SectionHeader
          eyebrow="For support, operations and compliance"
          id="operators-title"
          lead="The console is built for the people who get the question: support, operators, and whoever answers the auditor. Search every event, open a customer account or a single record, and see each change with its before and after values."
          title={'Answer "what happened in this account?" in one search.'}
        />
        <div className="mt-12 grid gap-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-start">
          <ScreenshotFrame
            caption="An event in detail: who asked, what did the work, whose account, which records, and the before and after of each change."
            id="event-sheet"
            label="Event detail"
            sizes="(min-width: 1024px) 680px, calc(100vw - 2rem)"
          />
          <div className="grid gap-6">
            <Feature compact icon={<SearchIcon className="size-4" />} title="Search">
              <code>actor:usr_42 action:booking.* outcome:failure</code>, or a guarded SQL <code>WHERE</code> expression.
            </Feature>
            <Feature compact icon={<BoxesIcon className="size-4" />} title="Entity pages">
              Every actor, tenant, executor and record gets its own page and timeline.
            </Feature>
            <Feature compact icon={<GitBranchIcon className="size-4" />} title="Operation trees">
              One request, the jobs it spawned and every record they changed, as one tree.
            </Feature>
            <Feature compact icon={<UserCogIcon className="size-4" />} title="Impersonation">
              When support acts for a customer, both names are on the event.
            </Feature>
            <Feature compact icon={<TimerResetIcon className="size-4" />} title="Retention">
              Per project, from 7 days to 10 years. Expired events are permanently deleted.
            </Feature>
          </div>
        </div>
        <div className="mt-10">
          <ButtonLink to="/product" variant="outline">
            Take the product tour
          </ButtonLink>
        </div>
      </Section>

      <Section id="how-it-works" labelledBy="how-title">
        <SectionHeader eyebrow="How it works" id="how-title" title="From one curl to a searchable history." />
        <div className="mt-12 flex flex-col gap-14">
          <Steps
            items={[
              { title: 'Create a project', body: "Copy its ingest key. It's shown once and stored only as a hash." },
              { title: 'Send events', body: 'Over HTTP or the SDK: one event, or up to 1000 per request.', detail: 'POST /v1/events' },
              { title: 'Logbird stores them', body: 'The server answers 202 only after ClickHouse has the rows.', detail: '202 Accepted' },
              {
                title: 'Search, follow, keep',
                body: 'Use the console, or read events from your own backend with a read key. Expired events are deleted every hour.',
              },
            ]}
          />
          <Architecture />
        </div>
      </Section>

      <Section id="envelope" labelledBy="envelope-title" tone="sunken">
        <SectionHeader
          eyebrow="The envelope at a glance"
          id="envelope-title"
          lead="Only action is required. These fields fill the console's pages and make search precise."
          title="Who caused it, what did the work, what changed."
        />
        <Envelope className="mt-12" />
        <div className="mt-10">
          <ButtonLink to="/developers" variant="outline">
            Read the envelope guide
          </ButtonLink>
        </div>
      </Section>

      <Section id="open-source" labelledBy="oss-title">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div className="flex flex-col gap-6">
            <SectionHeader
              eyebrow="Open source"
              id="oss-title"
              lead="The whole product is in one repository: the API, the console, the retention worker, the SDK and the integrations. Self-hosting builds it from source on your server, so your events stay on your infrastructure. No images are published yet."
              title={
                <>
                  MIT-licensed. Runs with <code className="font-mono text-[0.8em] tracking-normal">docker compose up</code>.
                </>
              }
            />
            <ul className="flex flex-col gap-3 text-sm">
              <li className="flex gap-3">
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
                Bundled Docker Compose, a Coolify build, or your own Postgres, ClickHouse and Redis.
              </li>
              <li className="flex gap-3">
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
                Automatic HTTPS with Caddy, or any reverse proxy you already run.
              </li>
              <li className="flex gap-3">
                <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
                Source on GitHub — coming soon. The repository opens publicly soon.
              </li>
            </ul>
            <div className="flex flex-wrap gap-3">
              <SelfHostCta size="default" />
              <ButtonLink to="/open-source" variant="ghost">
                What's in the repository
              </ButtonLink>
            </div>
          </div>
          {GITHUB_PUBLIC ? (
            <div className="flex min-w-0 flex-col gap-3">
              <SiteCode code={selfHost} language="bash" title="Self-host quickstart" />
              <p className="text-muted-foreground text-sm">
                Then open <code>http://localhost:4600</code>, sign in with the emailed code and create a project. Configure SMTP first, or enable
                sign-in codes in the server log.
              </p>
            </div>
          ) : (
            <div className="panel flex min-w-0 flex-col gap-4 p-6 md:p-8">
              <p className="eyebrow">Self-host quickstart</p>
              <p className="font-semibold text-lg">Available when the repository opens.</p>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Four commands on one VM: clone, generate secrets, configure SMTP, <code>docker compose up -d</code>. We'll publish them here the day
                the source is public.
              </p>
              <div>
                <ButtonLink search={{ interest: 'self-host' }} to="/contact" variant="outline">
                  Tell me when it opens
                </ButtonLink>
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section id="guarantees" labelledBy="guarantees-title" tone="sunken">
        <SectionHeader eyebrow="Guarantees and limits" id="guarantees-title" title="What Logbird promises, and where the promise ends." />
        <div className="mt-12">
          <Guarantees
            items={[
              { promise: 'A 202 means the event is stored in ClickHouse.', limit: 'Delivery is at least once; counts may include duplicates.' },
              {
                promise: 'The SDK batches and retries for you.',
                limit: 'Its queue is in memory: a crash before the server acknowledges can lose pending events.',
              },
              {
                promise: 'Any shape is accepted; only action is required.',
                limit: 'Events without an action are rejected one by one; the rest of the batch is stored.',
              },
              { promise: 'Retention deletes expired events for good.', limit: "There's no archive and no undo." },
              { promise: 'History starts the day you start sending.', limit: 'There is no backfill.' },
            ]}
          />
        </div>
        <div className="mt-10 flex items-center gap-3">
          <ShieldCheckIcon aria-hidden="true" className="size-4 text-muted-foreground" />
          <ButtonLink to="/security" variant="link">
            Read how Logbird handles data
          </ButtonLink>
        </div>
      </Section>

      <CtaBand note={DESIGN_PARTNER_LINE} />
    </>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden">
      <div aria-hidden="true" className="ledger-bg pointer-events-none absolute inset-0" />
      <div className="container-site relative grid gap-12 pt-14 pb-16 md:pt-24 md:pb-20 lg:min-h-[max(40rem,calc(100svh-var(--header-h)))] lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-center lg:py-16">
        <div className="flex min-w-0 flex-col gap-6">
          <Eyebrow>Open-source audit logs · MIT</Eyebrow>
          <h1 className="display" id="hero-title">
            Retrace every step.
            <span className="mt-3 block text-left font-medium text-[0.42em] text-muted-foreground tracking-normal" dir="rtl" lang="ar">
              تتبّع كل خطوة.
            </span>
          </h1>
          <p className="lead max-w-xl">
            Logbird is the audit log for your product. Send who-did-what events over HTTP or the SDK. Search them, follow any user, customer account
            or record, and run it on your own servers.
          </p>
          <div className="flex flex-wrap gap-3">
            <ButtonLink size="lg" to="/contact">
              Join the waitlist
            </ButtonLink>
            <SelfHostCta />
          </div>
          <p className="text-muted-foreground text-sm">
            {GITHUB_PUBLIC ? 'Logbird Cloud is not open yet.' : 'Source on GitHub — coming soon. Logbird Cloud is not open yet.'}
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <LogStack className="hidden sm:flex" />
          <LogStack className="sm:hidden" limit={3} />
          <div className="flex min-w-0 flex-col gap-2">
            <SiteCode code={curl} language="bash" title="Send your first event" wrap />
            <p className="text-muted-foreground text-sm">
              That's a valid event. Only <code>action</code> is required.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
