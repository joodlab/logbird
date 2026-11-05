import { Link } from '@tanstack/react-router';
import { Kbd } from '@trailmark/ui/components/ui/kbd';
import { ArrowUpRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { HighlightedQuery } from '@/components/query-input/highlighted';

/* Reference material that used to live on the Quickstart page; the Setup page renders it below the checklist. */

export const QUERY_SYNTAX: [string, string][] = [
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
  ['source:staybook', 'External system that supplied the change'],
  ['attr.metadata.plan:pro', 'Any attribute; unknown fields are treated as attr.<field>'],
  ['severity:critical  category:booking', 'Severity and first action segment'],
  ['"cancellation policy"', 'Free text over description, actor, tenant and target names'],
];

export const SHORTCUTS: [ReactNode, string][] = [
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

/** Actor vs executor vs operation: the semantics people get wrong first. */
export function EnvelopeSemantics() {
  return (
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
  );
}

/** Query language cheatsheet; each example opens in the explorer. */
export function QueryCheatsheet({ projectId }: { projectId: string }) {
  return (
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
  );
}

export function ShortcutList() {
  return (
    <ul className="divide-y rounded-xl border bg-card shadow-xs">
      {SHORTCUTS.map(([key, label]) => (
        <li className="flex items-center gap-4 px-4 py-2 text-sm" key={label}>
          <span className="w-24 shrink-0">{key}</span>
          <span className="text-muted-foreground">{label}</span>
        </li>
      ))}
    </ul>
  );
}
