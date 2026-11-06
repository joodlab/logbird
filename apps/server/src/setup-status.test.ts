import { ENVELOPE_FIELDS, SETUP_STEPS } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import { computeSetup } from './setup-status';

const project = { id: 'fixture', setupCompletedAt: null, retentionDays: 90, retentionReviewedAt: null, setupDismissedAt: null, keys: [] };
const events = {
  firstEvent: null,
  firstEventAt: null,
  lastEventAt: null,
  eventsLast24h: 0,
  sampleEvents: 0,
  sampledEvents: 0,
  avgConformance: 0,
  eventsWithOperationId: 0,
  fields: ENVELOPE_FIELDS.map((field) => ({ field, coverage: 0 })),
};
const team = { members: 1, pendingInvitations: 0 };
describe('setup computation', () => {
  it('preserves checklist order and prioritizes required steps', () => {
    const s = computeSetup(project, events, team);
    expect(s.steps.map((s) => s.id)).toEqual(SETUP_STEPS);
    expect(s.steps.every((s) => s.status === 'todo')).toBe(true);
    expect(s.nextStep).toBe('ingest_key');
    const ready = computeSetup(
      { ...project, keys: [{ kind: 'ingest', createdAt: new Date(0) }] },
      { ...events, firstEventAt: new Date(0).toISOString(), eventsLast24h: 1, sampledEvents: 1, avgConformance: 100 },
      team,
    );
    expect(ready.nextStep).toBe('retention');
    expect(ready.progress).toEqual({ done: 4, total: 8 });
  });
  it('reports samples, stopped ingestion and low conformance as attention', () => {
    expect(computeSetup(project, { ...events, sampleEvents: 2000 }, team).steps[1]?.status).toBe('attention');
    const s = computeSetup(project, { ...events, firstEventAt: new Date(0).toISOString(), sampledEvents: 1, avgConformance: 11 }, team);
    expect(s.steps[2]?.status).toBe('attention');
    expect(s.steps[3]?.status).toBe('attention');
    expect(s.steps[4]?.status).toBe('todo');
  });
  it('sorts fields by missing coverage and completes with pending teammate', () => {
    const date = new Date(0);
    const s = computeSetup(
      {
        ...project,
        retentionReviewedAt: date,
        setupDismissedAt: date,
        keys: [
          { kind: 'read', createdAt: date },
          { kind: 'ingest', createdAt: new Date(100) },
          { kind: 'ingest', createdAt: date },
        ],
      },
      {
        ...events,
        firstEventAt: date.toISOString(),
        eventsLast24h: 1,
        sampledEvents: 2,
        avgConformance: 70,
        eventsWithOperationId: 1,
        fields: events.fields.map((f) => ({ ...f, coverage: f.field === 'tenant' ? 0 : 1 })),
      },
      { members: 1, pendingInvitations: 1 },
    );
    expect(s.complete).toBe(true);
    expect(s.nextStep).toBeNull();
    expect(s.progress.done).toBe(8);
    expect(s.steps[0]?.completedAt).toBe(date.toISOString());
    expect(s.envelope.fields[0]?.field).toBe('tenant');
    expect(s.operations.coverage).toBe(0.5);
  });
});
