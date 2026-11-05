import type { SetupEventFacts } from '@trailmark/clickhouse';
import {
  ENVELOPE_MISSING_QUERIES,
  type ProjectSetup,
  SETUP_CONFORMANCE_TARGET,
  SETUP_REQUIRED_STEPS,
  SETUP_STEPS,
  type SetupStepId,
} from '@trailmark/contracts';

export interface SetupProjectFacts {
  id: string;
  retentionDays: number;
  retentionReviewedAt: Date | null;
  setupDismissedAt: Date | null;
  keys: { kind: string; createdAt: Date }[];
}
export function computeSetup(project: SetupProjectFacts, events: SetupEventFacts, team: ProjectSetup['team']): ProjectSetup {
  const keys = (kind: string) => project.keys.filter((k) => k.kind === kind).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const ingest = keys('ingest'),
    read = keys('read');
  const reviewedAt = project.retentionReviewedAt?.toISOString() ?? null;
  const done: Record<SetupStepId, boolean> = {
    ingest_key: ingest.length > 0,
    first_event: !!events.firstEventAt,
    recent_events: events.eventsLast24h > 0,
    envelope: events.sampledEvents > 0 && events.avgConformance >= SETUP_CONFORMANCE_TARGET,
    operation_id: events.eventsWithOperationId > 0,
    retention: !!reviewedAt,
    read_key: read.length > 0,
    teammate: team.members > 1 || team.pendingInvitations > 0,
  };
  const completed: Partial<Record<SetupStepId, string | null>> = {
    ingest_key: ingest[0]?.createdAt.toISOString(),
    first_event: events.firstEventAt,
    retention: reviewedAt,
    read_key: read[0]?.createdAt.toISOString(),
  };
  const steps = SETUP_STEPS.map((id) => ({
    id,
    required: SETUP_REQUIRED_STEPS.includes(id),
    status: done[id]
      ? ('done' as const)
      : (id === 'first_event' && events.sampleEvents > 0) ||
          (id === 'recent_events' && !!events.firstEventAt) ||
          (id === 'envelope' && events.sampledEvents > 0)
        ? ('attention' as const)
        : ('todo' as const),
    completedAt: done[id] ? (completed[id] ?? null) : null,
  }));
  const order = [...steps.filter((s) => s.required), ...steps.filter((s) => !s.required)];
  return {
    projectId: project.id,
    generatedAt: new Date().toISOString(),
    steps,
    progress: { done: steps.filter((s) => s.status === 'done').length, total: SETUP_STEPS.length },
    complete: steps.every((s) => s.status === 'done'),
    nextStep: order.find((s) => s.status !== 'done')?.id ?? null,
    dismissedAt: project.setupDismissedAt?.toISOString() ?? null,
    ingest: {
      activeIngestKeys: ingest.length,
      firstEvent: events.firstEvent,
      firstEventAt: events.firstEventAt,
      lastEventAt: events.lastEventAt,
      eventsLast24h: events.eventsLast24h,
      sampleEvents: events.sampleEvents,
    },
    envelope: {
      sampledEvents: events.sampledEvents,
      avgConformance: events.avgConformance,
      target: SETUP_CONFORMANCE_TARGET,
      fields: events.fields.map((f) => ({ ...f, missingQuery: ENVELOPE_MISSING_QUERIES[f.field] })).sort((a, b) => a.coverage - b.coverage),
    },
    operations: {
      coverage: events.sampledEvents ? events.eventsWithOperationId / events.sampledEvents : 0,
      eventsWithOperationId: events.eventsWithOperationId,
    },
    retention: { retentionDays: project.retentionDays, reviewedAt },
    readKeys: { active: read.length },
    team,
  };
}
