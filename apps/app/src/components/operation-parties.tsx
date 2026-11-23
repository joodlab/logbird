import type { AuditEvent } from '@logbird/contracts';
import { EntityLink } from '@/components/entity-link';
import { SupportAgentLink } from '@/components/impersonation';
import { NotRecorded, UnlinkedParty } from '@/components/not-recorded';
import { distinctParties, partyKey } from '@/lib/events';
import { formatNumber } from '@/lib/format';

/** How many actors the operation summary names before "and N more". */
const SHOWN_ACTORS = 4;

type Actor = NonNullable<AuditEvent['actor']>;
type Impersonator = NonNullable<AuditEvent['impersonator']>;
/** Who caused a step: the actor, and the support agent acting as them when the step was impersonated. */
type Cause = { actor: Actor | null; agent: Impersonator | null };

/**
 * Each distinct cause once, in the order first seen. The same actor with and without a support agent (or with two
 * different agents) are different causes, so an impersonated step never credits the customer alone. Later records of
 * the same cause win, as in `distinctParties`.
 */
export function distinctCauses(events: readonly Pick<AuditEvent, 'actor' | 'impersonator'>[]): Cause[] {
  const byKey = new Map<string, Cause>();
  for (const e of events) {
    const agent = e.impersonator?.id ? e.impersonator : null;
    const [actor] = distinctParties([e.actor]);
    if (!actor && !agent) continue;
    byKey.set(JSON.stringify([actor ? partyKey(actor) : '', agent?.id ?? '']), { actor: actor ?? null, agent });
  }
  return [...byKey.values()];
}

function ActorValue({ actor, projectId }: { actor: Actor; projectId: string }) {
  return actor.id ? (
    <EntityLink id={actor.id} kind="actor" name={actor.name} projectId={projectId} type={actor.type} />
  ) : (
    <UnlinkedParty party={actor} />
  );
}

/**
 * Who caused an operation and who performed it, from all of its events. Both parties always show: one no event named
 * says "Not recorded", as in the event drawer. A party with an id links to its profile; one without reads as text. An
 * impersonated step reads "Sam acting as Lina", as the drawer says it. Render it once the events are in, not while they
 * load (an empty list would read as "Not recorded").
 */
export function OperationParties({ events, projectId }: { events: readonly AuditEvent[]; projectId: string }) {
  const causes = distinctCauses(events);
  const executors = distinctParties(events.map((e) => e.executor));
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2 text-sm" data-testid="operation-parties">
      <span className="flex min-w-0 max-w-full flex-wrap items-center gap-2" data-testid="operation-actors">
        <span className="text-muted-foreground text-xs">Caused by</span>
        {causes.length === 0 ? <NotRecorded /> : null}
        {causes.slice(0, SHOWN_ACTORS).map(({ actor, agent }) => {
          const key = JSON.stringify([actor ? partyKey(actor) : '', agent?.id ?? '']);
          if (!agent) return actor ? <ActorValue actor={actor} key={key} projectId={projectId} /> : null;
          return (
            <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5" key={key}>
              <SupportAgentLink agentId={agent.id} className="font-medium text-support-foreground hover:underline" projectId={projectId}>
                <bdi>{agent.name || agent.id}</bdi>
              </SupportAgentLink>
              <span className="text-muted-foreground text-xs">acting as</span>
              {actor ? <ActorValue actor={actor} projectId={projectId} /> : <span className="text-muted-foreground">an unknown customer</span>}
            </span>
          );
        })}
        {causes.length > SHOWN_ACTORS ? (
          <span className="text-muted-foreground text-xs">and {formatNumber(causes.length - SHOWN_ACTORS)} more</span>
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
