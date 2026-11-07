import { createFileRoute } from '@tanstack/react-router';
import { ButtonLink } from '../components/marketing/button-link';
import { SiteCode } from '../components/marketing/code';
import { CtaBand } from '../components/marketing/cta-band';
import { FeatureRow, MiniFeature } from '../components/marketing/feature-row';
import { ClipFrame, ScreenshotFrame } from '../components/marketing/frame';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { SelfHostCta } from '../components/marketing/self-host-cta';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/product')({ head: () => pageHead('/product'), component: ProductPage });

// Copy: marketing/copy/product.md. Change wording there first.
const searchSample = `actor:usr_42 action:booking.* -env:staging
outcome:(failure OR denied) attempt:>2
tenant.name:"Azure Hotels" occurredAt:>now-7d
impersonator:*  metadata.channel:whatsapp`;

const readSample = `import { readAuditTrail, trailQuery } from '@logbird/sdk/read';

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

const toc = [
  ['explorer', 'Explorer'],
  ['search', 'Search'],
  ['sql-mode', 'SQL mode'],
  ['entities', 'Entity pages'],
  ['operations', 'Operations'],
  ['event-detail', 'Event detail'],
  ['setup', 'Setup'],
  ['retention', 'Retention'],
  ['read-api', 'Read API'],
] as const;

const sideSizes = '(min-width: 1024px) 640px, calc(100vw - 2rem)';

function ProductPage() {
  return (
    <>
      <PageHero
        actions={
          <>
            <ButtonLink size="lg" to="/contact">
              Join the waitlist
            </ButtonLink>
            <SelfHostCta />
          </>
        }
        eyebrow="Product"
        lead="The Logbird console is for the people who operate your product: engineers on call, support, and whoever answers the auditor. It is not a portal for your end customers. To show history inside your own product, use the read API."
        title={'Everything your team needs to answer "who did what".'}
      />

      <section aria-label="The console overview" className="pt-12">
        <div className="container-site flex flex-col gap-8">
          <ScreenshotFrame
            caption="The overview: events by outcome, the most frequent actions, and a setup checklist until your integration is complete."
            id="overview"
            label="Overview"
          />
          <nav aria-label="On this page" className="flex flex-wrap gap-2">
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
        </div>
      </section>

      <FeatureRow
        bullets={[
          'Facets with counts: click to include, Alt-click to exclude.',
          'Configurable columns and infinite scroll.',
          <>
            Keyboard first: <kbd>/</kbd> focuses search, <kbd>j</kbd> and <kbd>k</kbd> move through events, <kbd>Esc</kbd> closes the panel,{' '}
            <kbd>⌘K</kbd> opens the command palette.
          </>,
          'Export the current results as CSV or JSONL.',
        ]}
        eyebrow="Explorer"
        id="explorer"
        title="Every event, in one table."
        visual={<ClipFrame caption="Type a query, open an event, follow its operation." id="investigate" label="Explorer" />}
      >
        Pick a time range, type a query, and narrow it down with facets. Drag across the chart to zoom. Click a row to open the full event. Everything
        lives in the URL, so a link shows a teammate exactly what you see.
      </FeatureRow>

      <FeatureRow
        bullets={[
          'Fields are suggested from what your project actually sends, with how often each one appears.',
          'Errors point at the exact token and say what was expected, for example "attempt is a number".',
          'Any field you send, however deeply nested, is searchable by its dotted path.',
        ]}
        eyebrow="Search"
        id="search"
        reverse
        title="A query language you already half know."
        visual={
          <div className="flex flex-col gap-4">
            <SiteCode code={searchSample} language="text" title="Query language" />
            <ScreenshotFrame
              caption="Value suggestions with counts, and the operators that fit the field."
              id="query-suggestions"
              label="Search"
              sizes={sideSizes}
            />
          </div>
        }
      >
        Type <code>field:value</code> and Logbird suggests fields and values as you go. It covers what you'd expect from Lucene-style search:
        wildcards, negation, ranges, regex and groups. If you type KQL-style syntax like <code>f = v</code>, it offers to convert it.
      </FeatureRow>

      <Section compact id="sql-mode" labelledBy="sql-mode-title" tone="sunken">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)] lg:items-center lg:gap-14">
          <div className="flex flex-col gap-4">
            <p className="eyebrow">SQL mode</p>
            <h2 className="font-semibold text-[clamp(1.5rem,2.6vw,2rem)] leading-tight tracking-[-0.025em]" id="sql-mode-title">
              Or write a SQL <code className="font-mono text-[0.85em] tracking-normal">WHERE</code> expression, safely.
            </h2>
            <p className="body-copy text-muted-foreground leading-relaxed">
              Switch the bar to SQL and write a ClickHouse boolean expression, such as{' '}
              <code>job_attempt &gt; 2 AND attributes['metadata.channel'] = 'whatsapp'</code>. You write only the condition. Logbird writes the rest
              of the statement.
            </p>
          </div>
          <ScreenshotFrame caption="A subquery, rejected inline before anything runs." id="sql-rejected" label="SQL mode" sizes={sideSizes} />
        </div>
        <ol className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[
            ['Parsed by ClickHouse', "Logbird asks ClickHouse for the expression's syntax tree and checks it before running anything."],
            [
              'Allowlisted',
              'Only known columns and a fixed list of functions are allowed. Subqueries, joins, table functions, SETTINGS and system tables are rejected.',
            ],
            ['Run as a restricted user', 'Queries run as a separate read-only ClickHouse user with its own CPU, memory and row limits.'],
            ['Scoped to your project', "Database row policies limit that user to the project you're looking at, even if the expression is 1 OR 1."],
          ].map(([title, body], index) => (
            <li className="panel flex flex-col gap-2 p-5" key={title}>
              <span className="font-mono text-muted-foreground text-xs">Guard {index + 1}</span>
              <h3 className="font-semibold">{title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-muted-foreground text-sm">
          SQL mode is for the console only. The public read API accepts the query language, not SQL. A free-form SQL console isn't part of Logbird.
        </p>
      </Section>

      <FeatureRow
        bullets={[
          <>
            <strong className="font-medium text-foreground">Actors:</strong> who caused it. Users, API keys, integrations, the system.
          </>,
          <>
            <strong className="font-medium text-foreground">Tenants:</strong> whose account. "What happened at Azure Hotels last week?" is one click.
          </>,
          <>
            <strong className="font-medium text-foreground">Executors:</strong> what did the work. The API, each queue worker and cron job, with job
            ids and attempts.
          </>,
          <>
            <strong className="font-medium text-foreground">Records:</strong> what changed. <code>booking:bk_1042</code> has a history of its own.
          </>,
        ]}
        eyebrow="Follow anything"
        id="entities"
        title="A page for every actor, tenant, worker and record."
        visual={
          <ScreenshotFrame
            caption="A tenant's page: activity, top actions, outcomes, related entities and its timeline."
            id="tenant"
            label="Tenant"
            sizes={sideSizes}
          />
        }
      >
        Every actor, tenant, executor and record in your events gets its own page. Each one shows an activity chart, its top actions, its outcome
        split, related entities and a full timeline. Directory pages list them all, most active first, with fuzzy search.
      </FeatureRow>

      <FeatureRow
        eyebrow="Operation trees"
        id="operations"
        reverse
        title="One request, every job it started, as a single tree."
        visual={
          <ScreenshotFrame
            caption="An operation tree: a scheduler request, the jobs it started, failed attempts and the retries that worked."
            id="operation"
            label="Operation"
            sizes={sideSizes}
          />
        }
      >
        Send the same <code>operationId</code> on a request and the jobs it starts. Add <code>parentEventId</code> to say which event caused which.
        Logbird draws the tree: each step with its outcome, executor and timing. A failed first attempt and the retry that worked sit side by side.
      </FeatureRow>

      <FeatureRow
        bullets={[
          'Before and after values for every changed field.',
          'The causation breadcrumb, with a link to the whole operation.',
          'Context ids (request, trace, IP), every custom attribute, and the raw JSON exactly as received.',
          'Copy a link, or copy the event as a curl command.',
        ]}
        eyebrow="Event detail"
        id="event-detail"
        title="The full story of one event."
        visual={
          <ScreenshotFrame
            caption="When staff act for a customer, the customer stays the actor and the staff member gets an impersonator card."
            id="impersonation"
            label="Event detail"
            sizes={sideSizes}
          />
        }
      >
        Open any event to read it as a sentence: who did what, in which account, to which records, and how it ended. The actor and the executor are on
        separate cards. When staff acted for a customer, the impersonator gets a card too.
      </FeatureRow>

      <Section compact labelledBy="more-title" tone="sunken">
        <SectionHeader id="more-title" title="And the parts you use every day." />
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <MiniFeature
            eyebrow="Live"
            id="live-tail"
            limit="Live tail polls over HTTP. It doesn't use WebSockets, so it works behind any proxy."
            title="Watch events arrive during a deploy."
          >
            Turn on Live and new events appear at the top of the table as they arrive, with your current query still applied.
          </MiniFeature>
          <MiniFeature eyebrow="Saved views" id="saved-views" title="Save the searches your team runs every week.">
            Save a query, its time range and its columns as a view, in query or SQL mode. Views appear in the sidebar and in the search bar's
            suggestions. Anyone in the workspace can open them; members can delete their own.
          </MiniFeature>
          <MiniFeature eyebrow="Workspace activity" id="workspace-activity" title="Logbird records its own management actions.">
            Logbird records management actions (projects, keys, retention, invitations) in workspace activity. You read it with the same explorer.
          </MiniFeature>
          <MiniFeature
            eyebrow="Workspaces and roles"
            id="team"
            limit="SSO isn't available yet. It's on the roadmap."
            title="Owners and admins manage it. Members use it."
          >
            Sign-in is by emailed one-time code. There are no passwords. Owners and admins manage projects, keys, retention and invitations. Members
            search, export, save views and read workspace activity. The server checks every role on every request.
          </MiniFeature>
        </div>
      </Section>

      <FeatureRow
        bullets={[
          'Onboarding picks up where you left off.',
          '"Send a test event" and "Load sample data" show the console before you integrate. Sample data is 2000 fictional events over seven days; it never counts as setup, and you can remove it.',
          'A conformance score on every event, and a Fields page that shows every field you send and how often.',
        ]}
        eyebrow="Setup that checks itself"
        id="setup"
        title="The setup page tells you what's still missing."
        visual={
          <ScreenshotFrame
            caption="The setup page checks each part of the integration against the events it has received."
            id="setup"
            label="Setup"
            sizes={sideSizes}
          />
        }
      >
        Send your first event and the setup page notices on its own. It then checks each part of your integration against your real events: actors,
        tenants, executors, targets, operation ids, retention and team invitations. For each gap it links to the events that are missing that field.
      </FeatureRow>

      <FeatureRow
        eyebrow="Retention"
        id="retention"
        limit="Retention deletes are permanent. There's no archive and no undo. The preview count is approximate, because storage is at least once."
        reverse
        title="Keep events exactly as long as you decide."
        visual={
          <ScreenshotFrame
            caption="Lowering retention: the preview shows what will be deleted, and you confirm by typing the project's slug."
            id="retention"
            label="Retention"
            sizes={sideSizes}
          />
        }
      >
        Each project keeps events for a window you choose, from 7 days to 10 years. New projects start at 90 days. A worker deletes expired events
        every hour. Before you lower the window, Logbird shows how many events will be deleted. To confirm, you type the project's slug, and the purge
        starts right away.
      </FeatureRow>

      <FeatureRow
        eyebrow="Read API"
        id="read-api"
        limit="A read key can read the whole project. Your backend must check that the person asking may see that tenant or record, on every page it fetches."
        title="Show history inside your own product."
        visual={<SiteCode code={readSample} language="ts" title="Your backend" />}
      >
        Give your customers a "History" tab. Your backend calls <code>GET /v1/events</code> with a read key and a query such as{' '}
        <code>target:bk_1042 tenant:biz_7</code>, then returns the page to your UI. Results are paginated with a cursor. The Vue, Nuxt and TanStack
        Start packages include helpers for this.
        <span className="mt-4 block">
          <ButtonLink to="/developers" variant="link">
            Read API on the developer page
          </ButtonLink>
        </span>
      </FeatureRow>

      <Section labelledBy="roadmap-title">
        <SectionHeader
          eyebrow="On the roadmap"
          id="roadmap-title"
          lead="These are plans, not features. Order and timing can change."
          title="What we plan to build next."
        />
        <ul className="mt-10 grid gap-x-10 gap-y-3 md:grid-cols-2">
          {[
            "Tenant-scoped read tokens, so a browser can read one customer's history without a project-wide key.",
            'Per-project redaction rules, applied before events are stored.',
            'Alert rules on chosen actions, by email or webhook.',
            'Webhooks and streaming export for SIEM and long-term archives.',
            'Per-tenant export on the read API.',
            'SSO (OIDC) for the console.',
          ].map((item) => (
            <li className="flex gap-3 border-b py-3 text-sm leading-relaxed" key={item}>
              <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full border border-dashed border-muted-foreground" />
              {item}
            </li>
          ))}
        </ul>
      </Section>

      <CtaBand />
    </>
  );
}
