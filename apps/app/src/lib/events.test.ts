import type { AuditEvent } from '@trailmark/contracts';
import { describe, expect, it } from 'vitest';
import { actorLabel, eventSentence, humanizeNoun } from './events';

function event(patch: Partial<AuditEvent>): AuditEvent {
  return {
    id: 'evt_1',
    timestamp: '2026-11-05T10:00:00.000Z',
    receivedAt: '2026-11-05T10:00:00.000Z',
    environment: 'production',
    action: 'thing.done',
    category: 'thing',
    outcome: 'success',
    severity: 'info',
    description: '',
    actor: null,
    impersonator: null,
    executor: null,
    tenant: null,
    source: null,
    targets: [],
    changes: [],
    context: { operationId: '', parentEventId: '', requestId: '', traceId: '', ip: '', userAgent: '' },
    attributes: {},
    conformance: 0,
    schemaVersion: '1',
    sdk: '',
    ...patch,
  } as AuditEvent;
}

const vera = { type: 'user', id: 'usr_vera', name: 'Vera Validator', email: 'vera@trailmark.local' };

describe('eventSentence', () => {
  it('keeps a producer description', () => {
    expect(eventSentence(event({ description: 'Lina changed the policy', actor: vera }))).toBe('Lina changed the policy');
  });

  it('humanizes nouns and quotes a named target of the same kind', () => {
    const e = event({
      action: 'api_key.created',
      description: 'api_key.created',
      actor: vera,
      targets: [{ type: 'api_key', id: 'key_1', name: 'Production' }],
    });
    expect(eventSentence(e)).toBe('Vera Validator created API key ‘Production’');
  });

  it('falls back to the humanized noun when the target has no name', () => {
    const e = event({ action: 'invite_link.created', actor: vera, targets: [{ type: 'invite_link', id: 'lnk_1', name: '' }] });
    expect(eventSentence(e)).toBe('Vera Validator created an invite link');
  });

  it('credits a nameless user by email', () => {
    const joiner = { type: 'user', id: 'eDfVurSJNLRLYBx3fzSXdguaj2B79GOg', name: '', email: 'max@trailmark.local' };
    const e = event({ action: 'member.joined_via_link', actor: joiner, targets: [{ type: 'user', id: joiner.id, name: '' }] });
    expect(eventSentence(e)).toBe('max@trailmark.local joined via link');
    expect(actorLabel(e)).toBe('max@trailmark.local');
  });

  it('never says "Something" for an action-only event', () => {
    const sentence = eventSentence(event({ action: 'validator.key.check' }));
    expect(sentence).toBe('validator.key.check');
    expect(sentence).not.toMatch(/something/i);
  });

  it('names the changed part of a target of another kind', () => {
    const e = event({
      action: 'hotel.policy.updated',
      actor: { type: 'user', id: 'usr_42', name: 'Lina', email: '' },
      targets: [{ type: 'hotel', id: 'hotel_123', name: 'Hotel Sunrise' }],
    });
    expect(eventSentence(e)).toBe('Lina updated Hotel Sunrise’s policy');
  });

  it('names a target of another kind by its name for other verbs', () => {
    const e = event({
      action: 'hotel.policy.approved',
      actor: { type: 'user', id: 'usr_42', name: 'Lina', email: '' },
      targets: [{ type: 'hotel', id: 'hotel_123', name: 'Hotel Sunrise' }],
    });
    expect(eventSentence(e)).toBe('Lina approved Hotel Sunrise');
  });

  it('credits machine executors for work they performed', () => {
    const e = event({
      action: 'crm.contact.upserted',
      actor: vera,
      executor: { type: 'worker', id: 'crm-worker', name: 'CRM worker', jobId: '1', attempt: 1 },
    });
    expect(eventSentence(e)).toBe('CRM worker upserted a crm contact');
  });
});

describe('eventSentence for Trailmark management actions', () => {
  const ada = { type: 'user', id: 'usr_ada', name: 'Ada Admin', email: 'ada@trailmark.local' };
  const audit = (patch: Partial<AuditEvent>) =>
    event({ actor: ada, executor: { type: 'api', id: 'api-server', name: '', jobId: '', attempt: 0 }, ...patch });

  it('reads a role change from its recorded change', () => {
    const e = audit({
      action: 'member.role.changed',
      description: 'member.role.changed',
      targets: [{ type: 'user', id: 'usr_2', name: 'member2@trailmark.local' }],
      changes: [{ field: 'role', before: 'admin', after: 'member' }],
    });
    expect(eventSentence(e)).toBe('Ada Admin changed member2@trailmark.local’s role from Admin to Member');
  });

  it('reads a retention change in days', () => {
    const e = audit({
      action: 'project.retention.changed',
      targets: [{ type: 'project', id: 'prj_1', name: 'Validator2 Empty' }],
      changes: [{ field: 'retentionDays', before: '90', after: '180' }],
    });
    expect(eventSentence(e)).toBe('Ada Admin changed Validator2 Empty’s retention from 90 to 180 days');
    const years = audit({ ...e, changes: [{ field: 'retentionDays', before: '90', after: '365' }] });
    expect(eventSentence(years)).toBe('Ada Admin changed Validator2 Empty’s retention from 90 days to 1 year');
  });

  it('names what changed when the change list is absent', () => {
    const e = audit({ action: 'member.role.changed', targets: [{ type: 'user', id: 'usr_2', name: 'Omar Nasser' }] });
    expect(eventSentence(e)).toBe('Ada Admin changed Omar Nasser’s role');
    const s = audit({ action: 'project.retention.changed', targets: [{ type: 'project', id: 'prj_1', name: 'Cedar Courtyard Bookings' }] });
    expect(eventSentence(s)).toBe('Ada Admin changed Cedar Courtyard Bookings’ retention');
  });

  it('summarizes several changes on a project update', () => {
    const e = audit({
      action: 'project.updated',
      targets: [{ type: 'project', id: 'prj_1', name: 'Front desk' }],
      changes: [
        { field: 'name', before: 'Front office', after: 'Front desk' },
        { field: 'description', before: '', after: 'Check-ins' },
      ],
    });
    expect(eventSentence(e)).toBe('Ada Admin changed Front desk’s name and description');
    const one = audit({ ...e, changes: [{ field: 'name', before: 'Front office', after: 'Front desk' }] });
    expect(eventSentence(one)).toBe('Ada Admin changed Front desk’s name from Front office to Front desk');
    expect(eventSentence(audit({ ...e, changes: [] }))).toBe('Ada Admin updated project ‘Front desk’');
  });

  it('never prints a redacted or very long value inline', () => {
    const e = audit({
      action: 'project.updated',
      targets: [{ type: 'project', id: 'prj_1', name: 'Front desk' }],
      changes: [{ field: 'webhookSecret', before: '[redacted]', after: '[redacted]' }],
    });
    expect(eventSentence(e)).toBe('Ada Admin changed Front desk’s webhook secret');
  });

  it('quotes a saved view by name, and reads naturally without one', () => {
    const named = audit({ action: 'saved_view.deleted', targets: [{ type: 'saved_view', id: 'v1', name: 'T10 ok' }] });
    expect(eventSentence(named)).toBe('Ada Admin deleted saved view ‘T10 ok’');
    const nameless = audit({ action: 'saved_view.deleted', targets: [{ type: 'saved_view', id: 'v1', name: '' }] });
    expect(eventSentence(nameless)).toBe('Ada Admin deleted a saved view');
  });

  it('describes sample data, retention reviews, setup and invite links', () => {
    const project = [{ type: 'project', id: 'prj_1', name: 'Validator2 Sandbox' }];
    expect(eventSentence(audit({ action: 'project.sample_data.loaded', targets: project }))).toBe(
      'Ada Admin loaded sample data into Validator2 Sandbox',
    );
    expect(eventSentence(audit({ action: 'project.sample_data.removed', targets: project }))).toBe(
      'Ada Admin removed sample data from Validator2 Sandbox',
    );
    expect(eventSentence(audit({ action: 'project.retention.reviewed', targets: project }))).toBe(
      'Ada Admin reviewed retention for Validator2 Sandbox',
    );
    expect(
      eventSentence(
        audit({ action: 'project.setup.dismissed', targets: project, changes: [{ field: 'setupDismissed', before: '', after: 'true' }] }),
      ),
    ).toBe('Ada Admin dismissed the setup checklist for Validator2 Sandbox');
    expect(
      eventSentence(
        audit({ action: 'project.setup.dismissed', targets: project, changes: [{ field: 'setupDismissed', before: '', after: 'false' }] }),
      ),
    ).toBe('Ada Admin restored the setup checklist for Validator2 Sandbox');
    const link = [{ type: 'invite_link', id: 'lnk_1', name: 'member' }];
    expect(eventSentence(audit({ action: 'invite_link.created', targets: link }))).toBe('Ada Admin created a member invite link');
    expect(eventSentence(audit({ action: 'invite_link.revoked', targets: [{ ...link[0], name: 'admin' }] as never }))).toBe(
      'Ada Admin revoked an admin invite link',
    );
  });
});

describe('humanizeNoun', () => {
  it('splits separators and upper-cases acronyms', () => {
    expect(humanizeNoun('api_key')).toBe('API key');
    expect(humanizeNoun('project.sample_data')).toBe('project sample data');
    expect(humanizeNoun('retentionDays')).toBe('retention days');
  });
});
