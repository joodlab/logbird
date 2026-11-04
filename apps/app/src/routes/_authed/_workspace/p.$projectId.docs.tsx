import { createFileRoute, Link } from '@tanstack/react-router';
import { CodeBlock, CodeTabs } from '@trailmark/ui/components/code-block';
import { Kbd } from '@trailmark/ui/components/ui/kbd';
import { ArrowUpRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { HighlightedQuery } from '@/components/explorer/query-bar';
import { curlSnippet, ENVELOPE_EXAMPLE, readCurlSnippet, SDK_INSTALL, sdkSnippet } from '@/lib/snippets';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/docs')({
  staticData: { crumb: 'Quickstart' },
  head: () => ({ meta: [{ title: 'Quickstart · Trailmark' }] }),
  component: DocsPage,
});

const TOC = [
  ['install', 'Install the SDK'],
  ['send', 'Send an event'],
  ['envelope', 'Recommended envelope'],
  ['semantics', 'Actor, executor, operation'],
  ['query', 'Query language'],
  ['keys', 'Keyboard shortcuts'],
  ['read', 'Read API'],
] as const;

const QUERY_SYNTAX: [string, string][] = [
  ['action:hotel.policy.updated', 'Exact action'],
  ['action:hotel.*', 'Prefix wildcard'],
  ['outcome:failure', 'Outcome: success · failure · denied · partial · unknown'],
  ['-env:staging', 'Negate any term with a leading -'],
  ['(outcome:failure OR outcome:denied) action:booking.*', 'OR and parentheses; adjacent terms are ANDed'],
  ['actor:usr_42', 'Actor id (also actor.type, actor.email)'],
  ['actor.name:"Raed Al-Harbi"', 'Quote values with spaces'],
  ['impersonator:usr_1', 'Actions a support user took while impersonating'],
  ['impersonator:*   -impersonator:*', 'field:* = the field is present (non-empty); -field:* = missing'],
  ['tenant:biz_7   tenant.name:"Azure Hotels"', 'Tenant by id or by name'],
  ['executor:crm-worker   executor.name:"CRM worker"', 'Who performed it (also executor.type:worker)'],
  ['job:456', 'Everything one job run did'],
  ['target:hotel_123', 'Any target id (also target.type:hotel)'],
  ['operation:op_101', 'Everything in one operation'],
  ['parent:evt_123', 'Direct children of an event in the causation tree'],
  ['request:req_abc   trace:4bf92f…', 'Request and trace ids'],
  ['source:joodbooking', 'External system that supplied the change'],
  ['attr.metadata.plan:pro', 'Any attribute; unknown fields are treated as attr.<field>'],
  ['severity:critical  category:booking', 'Severity and first action segment'],
  ['"cancellation policy"', 'Free text over description, actor, tenant and target names'],
];

const SHORTCUTS: [ReactNode, string][] = [
  [<Kbd key="k">⌘K</Kbd>, 'Command palette: pages, entities, event and operation ids, projects, theme'],
  [<Kbd key="s">/</Kbd>, 'Focus the query bar in the explorer'],
  [
    <span className="flex gap-1" key="jk">
      <Kbd>j</Kbd>
      <Kbd>k</Kbd>
    </span>,
    'Move down / up through events (also inside the event panel)',
  ],
  [<Kbd key="e">Enter</Kbd>, 'Open the highlighted event'],
  [<Kbd key="esc">Esc</Kbd>, 'Close the event panel or autocomplete'],
  [<Kbd key="alt">⌥ click</Kbd>, 'Exclude a facet value instead of including it'],
  [<Kbd key="b">⌘B</Kbd>, 'Collapse or expand the sidebar'],
];

function Heading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 className="scroll-mt-20 font-semibold text-lg tracking-tight" id={id}>
      <a className="hover:underline hover:underline-offset-4" href={`#${id}`}>
        {children}
      </a>
    </h2>
  );
}

function DocsPage() {
  const { projectId } = Route.useParams();
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-10 p-4 sm:p-6 lg:grid-cols-[1fr_200px]">
      <article className="flex min-w-0 flex-col gap-10">
        <header className="flex flex-col gap-2">
          <h1 className="font-semibold text-2xl tracking-tight">Quickstart</h1>
          <p className="max-w-2xl text-muted-foreground">
            Trailmark accepts any JSON object with an <span className="font-mono text-foreground">action</span>. Send what you have today, then grow
            into the recommended envelope — every extra field you add becomes searchable.
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <Heading id="install">1 · Install the SDK</Heading>
          <CodeBlock code={SDK_INSTALL} language="bash" />
          <p className="text-muted-foreground text-sm">
            The SDK batches events, retries with idempotent ids and never throws from <span className="font-mono text-foreground">track()</span>.
            Create an ingest key in{' '}
            <Link className="text-foreground underline underline-offset-2" params={{ projectId }} to="/p/$projectId/settings/keys">
              Settings → API keys
            </Link>{' '}
            and export it — every snippet on this page reads it from the environment, so it runs as pasted:
          </p>
          <CodeBlock code="export TRAILMARK_INGEST_KEY=tm_ingest_…   # and TRAILMARK_READ_KEY=tm_read_… for the read API" language="bash" />
        </section>

        <section className="flex flex-col gap-3">
          <Heading id="send">2 · Send an event</Heading>
          <CodeTabs
            tabs={[
              { id: 'sdk', label: 'TypeScript', code: sdkSnippet(), language: 'ts' },
              { id: 'curl', label: 'curl', code: curlSnippet(), language: 'bash' },
            ]}
          />
          <p className="text-muted-foreground text-sm">
            <span className="font-mono text-foreground">POST /v1/events</span> takes one event or{' '}
            <span className="font-mono text-foreground">{'{ "events": [...] }'}</span> (up to 1000 events or 5 MB). A{' '}
            <span className="font-mono text-foreground">202</span> means the events are durably stored and searchable within seconds.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <Heading id="envelope">3 · Recommended envelope</Heading>
          <p className="text-muted-foreground text-sm">
            Recognized fields become indexed columns. Everything else is flattened into attributes, and the raw document is always kept.
          </p>
          <CodeBlock code={ENVELOPE_EXAMPLE} language="json" maxHeight={520} />
        </section>

        <section className="flex flex-col gap-4">
          <Heading id="semantics">4 · Actor, executor, operation</Heading>
          <div className="grid gap-3 md:grid-cols-2">
            {[
              ['actor', 'Who caused it — a person, API key, integration or the system (scheduled runs use actor.type = system).'],
              [
                'executor',
                'Who performed it — api, worker, scheduler, webhook — with jobId and attempt. A worker doing Raed’s work has actor = Raed, executor = crm-worker.',
              ],
              ['impersonator', 'Who was at the keyboard when support acted as a customer. The actor stays the customer.'],
              ['context.operationId', 'Groups a request, the jobs it spawned and every record they changed. parentEventId forms the causation tree.'],
              ['changes', 'Before/after values you are allowed to keep. Never send secrets — send “[redacted]” to record that a secret changed.'],
              ['targets', 'Every record the event touched. Each one gets its own history page under Records.'],
            ].map(([k, v]) => (
              <div className="flex flex-col gap-1 rounded-xl border bg-card p-4 shadow-xs" key={k}>
                <span className="font-mono text-[13px]">{k}</span>
                <span className="text-muted-foreground text-sm">{v}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <Heading id="query">5 · Query language</Heading>
          <p className="text-muted-foreground text-sm">
            Adjacent terms are ANDed; use <span className="font-mono text-foreground">OR</span> and parentheses for alternatives. Click an example to
            run it in the explorer.
          </p>
          <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {QUERY_SYNTAX.map(([q, meaning]) => (
                  <tr className="group" key={q}>
                    <td className="w-[46%] px-4 py-2 align-top">
                      <Link
                        className="inline-flex items-center gap-1 font-mono text-[12.5px]"
                        params={{ projectId }}
                        search={(prev) => ({ range: prev.range ?? '7d', q: q.split('   ')[0] })}
                        to="/p/$projectId/events"
                      >
                        <HighlightedQuery value={q} />
                        <ArrowUpRightIcon className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <Heading id="keys">6 · Keyboard shortcuts</Heading>
          <ul className="divide-y rounded-xl border bg-card shadow-xs">
            {SHORTCUTS.map(([key, label]) => (
              <li className="flex items-center gap-4 px-4 py-2 text-sm" key={label}>
                <span className="w-24 shrink-0">{key}</span>
                <span className="text-muted-foreground">{label}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-3">
          <Heading id="read">7 · Read API</Heading>
          <p className="text-muted-foreground text-sm">
            Products that show history to their own users read through <span className="font-mono text-foreground">GET /v1/events</span> with a read
            key and the same query language.
          </p>
          <CodeBlock code={readCurlSnippet()} language="bash" />
        </section>
      </article>
      <nav aria-label="On this page" className="hidden lg:block">
        <div className="sticky top-20 flex flex-col gap-1 text-sm">
          <span className="pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">On this page</span>
          {TOC.map(([id, label]) => (
            <a className="rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground" href={`#${id}`} key={id}>
              {label}
            </a>
          ))}
        </div>
      </nav>
    </div>
  );
}
