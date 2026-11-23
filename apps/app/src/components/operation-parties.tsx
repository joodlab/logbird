import type { AuditEvent } from '@logbird/contracts';
import { EntityLink } from '@/components/entity-link';
import { NotRecorded, UnlinkedParty } from '@/components/not-recorded';
import { distinctParties, partyKey } from '@/lib/events';
import { formatNumber } from '@/lib/format';

/** How many actors the operation summary names before "and N more". */
const SHOWN_ACTORS = 4;

/**
 * Who caused an operation and who performed it, from all of its events. Both parties always show: one no event named
 * says "Not recorded", as in the event drawer. A party with an id links to its profile; one without reads as text.
 * Render it once the events are in, not while they load (an empty list would read as "Not recorded").
 */
export function OperationParties({ events, projectId }: { events: readonly AuditEvent[]; projectId: string }) {
  const actors = distinctParties(events.map((e) => e.actor));
  const executors = distinctParties(events.map((e) => e.executor));
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2 text-sm" data-testid="operation-parties">
      <span className="flex min-w-0 max-w-full flex-wrap items-center gap-2" data-testid="operation-actors">
        <span className="text-muted-foreground text-xs">Caused by</span>
        {actors.length === 0 ? <NotRecorded /> : null}
        {actors
          .slice(0, SHOWN_ACTORS)
          .map((a) =>
            a.id ? (
              <EntityLink id={a.id} key={partyKey(a)} kind="actor" name={a.name} projectId={projectId} type={a.type} />
            ) : (
              <UnlinkedParty key={partyKey(a)} party={a} />
            ),
          )}
        {actors.length > SHOWN_ACTORS ? (
          <span className="text-muted-foreground text-xs">and {formatNumber(actors.length - SHOWN_ACTORS)} more</span>
        ) : null}
      </span>
      <span className="flex min-w-0 max-w-full flex-wrap items-center gap-2" data-testid="operation-executors">
        <span className="text-muted-foreground text-xs">Performed by</span>
        {executors.length === 0 ? <NotRecorded /> : null}
        {executors.map((x) =>
          x.id ? (
            <EntityLink id={x.id} key={partyKey(x)} kind="executor" meta={x.type} name={x.name} projectId={projectId} type={x.type} />
          ) : (
            <UnlinkedParty key={partyKey(x)} party={x} />
          ),
        )}
      </span>
    </div>
  );
}
