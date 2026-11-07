import { Kbd } from '@logbird/ui/components/ui/kbd';
import { Link } from '@tanstack/react-router';
import { ArrowUpRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { HighlightedQuery } from '@/components/query-input/highlighted';
import { modKeyLabel, useIsMac } from '@/lib/platform';

/* Reference material that used to live on the Quickstart page; the Setup page renders it below the checklist. */

export function EventIdsAndRetries() {
  return (
    <div className="flex flex-col gap-3 text-muted-foreground text-sm" id="event-ids-and-retries">
      <h3 className="font-medium text-foreground">Event ids and retries</h3>
      <p>
        Each id names one immutable event in a project. Exact retries are accepted without storing or counting the event again. Object key order may
        change; array order and string contents must stay identical.
      </p>
      <p>
        The SDK creates an id and timestamp once per queued event. Deterministic ids need identical content across calls, including occurredAt and
        executor.attempt. Omitted or invalid occurredAt keeps the first receipt clock.
      </p>
      <p>
        <code>duplicate_id_conflict</code> means different content reused an id; the original is kept. Send a correction with a new id and{' '}
        <code>context.parentEventId</code> pointing to the original.
      </p>
      <p>
        <code>503 ingest_pending</code> or <code>ingest_unavailable</code> means retry the identical batch with Retry-After. Healthy siblings commit
        before a pending response. Pending details include accepted, ids, rejected, warnings, indices and eventIds. Every index outside indices is
        settled. Rejected entries include a code and explanation. The SDK retries; if its budget expires, flush rejects and keeps the batch for a
        later flush.
      </p>
      <p>
        Use string ids. Numeric ids generate a fresh UUID and a warning; convert with String(id) first. Ids over 256 UTF-16 code units after trimming,
        containing NUL or invalid Unicode are rejected individually as <code>invalid_event_id</code>.
      </p>
    </div>
  );
}

export const QUERY_SYNTAX: [string, string][] = [
  ['action:hotel.policy.updated', 'Exact action'],
  ['action:hotel.*', 'Prefix wildcard'],
  ['outcome:failure', 'Outcome: success · failure · denied · partial · unknown'],
  ['-env:staging', 'Negate any term with a leading -'],
  ['(outcome:failure OR outcome:denied) action:booking.*', 'OR and parentheses; adjacent terms are ANDed'],
  ['actor:usr_42', 'Actor id (also actor.type, actor.email)'],
  ['actor.name:"Lina Haddad"', 'Quote values with spaces'],
  ['impersonator:usr_1', 'Actions a support user took while impersonating'],
  ['impersonator:*   -impersonator:*', 'field:* = the field is present (non-empty); -field:* = missing'],
  ['tenant:biz_7   tenant.name:"Azure Hotels"', 'Tenant by id or by name'],
  ['executor:crm-worker   executor.name:"CRM worker"', 'Who performed it (also executor.type:worker)'],
  ['job:456', 'Everything one job run did'],
  ['target:hotel_123', 'Any target id (also target.type:hotel)'],
  ['operation:op_101', 'Everything in one operation'],
  ['parent:evt_123', 'Direct children of an event in the causation tree'],
  ['request:req_abc   trace:4bf92f…', 'Request and trace ids'],
  ['source:channel-manager', 'External system that supplied the change'],
  ['attr.metadata.plan:pro', 'Any attribute; unknown fields are treated as attr.<field>'],
  ['severity:critical  category:booking', 'Severity and first action segment'],
  ['"cancellation policy"', 'Free text over description, actor, tenant and target names'],
];

/** Keyboard shortcuts with the modifier names of the viewer's platform (⌘/⌥ on Mac, Ctrl/Alt elsewhere). */
export function shortcuts(isMac: boolean): [ReactNode, string][] {
  return [
    [<Kbd key="k">{modKeyLabel(isMac, 'K')}</Kbd>, 'Command palette: pages, entities, event and operation ids, projects, theme'],
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
    [<Kbd key="alt">{isMac ? '⌥ click' : 'Alt click'}</Kbd>, 'Exclude a facet value instead of including it'],
    [<Kbd key="b">{modKeyLabel(isMac, 'B')}</Kbd>, 'Collapse or expand the sidebar'],
  ];
}

/** Actor vs executor vs operation: the semantics people get wrong first. */
export function EnvelopeSemantics() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {[
        ['actor', 'Who caused it — a person, API key, integration or the system (scheduled runs use actor.type = system).'],
        [
          'executor',
          'Who performed it — api, worker, scheduler, webhook — with jobId and attempt. A worker doing Lina’s work has actor = Lina, executor = crm-worker.',
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

/**
 * Query language cheatsheet; each example opens in the explorer. Below `sm` each row stacks (example over meaning) and
 * long examples wrap, so nothing is clipped on a phone. The example renders inline: a flex container would split the
 * highlighted tokens into flex items (spacing out "action : hotel") and stop them wrapping.
 */
export function QueryCheatsheet({ projectId }: { projectId: string }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-xs" data-testid="query-cheatsheet">
      <table className="w-full text-sm max-sm:block">
        <tbody className="divide-y max-sm:block">
          {QUERY_SYNTAX.map(([q, meaning]) => (
            <tr className="group max-sm:flex max-sm:flex-col max-sm:gap-1 max-sm:py-2.5" key={q}>
              <td className="px-4 py-2 align-top max-sm:py-0 sm:w-[46%]">
                <Link
                  className="font-mono text-[12.5px] [overflow-wrap:anywhere]"
                  params={{ projectId }}
                  search={(prev) => ({ range: prev.range ?? '7d', q: q.split('   ')[0] })}
                  to="/p/$projectId/events"
                >
                  <HighlightedQuery value={q} />
                  <ArrowUpRightIcon className="ms-1 inline size-3 align-[-1px] text-muted-foreground opacity-0 group-hover:opacity-100" />
                </Link>
              </td>
              <td className="px-4 py-2 text-muted-foreground max-sm:py-0 max-sm:text-[13px]">{meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ShortcutList() {
  const isMac = useIsMac();
  return (
    <ul className="divide-y rounded-xl border bg-card shadow-xs" data-testid="shortcut-list">
      {shortcuts(isMac).map(([key, label]) => (
        <li className="flex items-center gap-4 px-4 py-2 text-sm" key={label}>
          <span className="w-24 shrink-0">{key}</span>
          <span className="text-muted-foreground">{label}</span>
        </li>
      ))}
    </ul>
  );
}
