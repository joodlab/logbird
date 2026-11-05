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
    expect(eventSentence(event({ description: 'Raed changed the policy', actor: vera }))).toBe('Raed changed the policy');
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
    expect(eventSentence(e)).toBe('Vera Validator created invite link');
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

  it('names a target of another kind by its name', () => {
    const e = event({
      action: 'hotel.policy.updated',
      actor: { type: 'user', id: 'usr_42', name: 'Raed', email: '' },
      targets: [{ type: 'hotel', id: 'hotel_123', name: 'Hotel Sunrise' }],
    });
    expect(eventSentence(e)).toBe('Raed updated Hotel Sunrise');
  });

  it('credits machine executors for work they performed', () => {
    const e = event({
      action: 'crm.contact.upserted',
      actor: vera,
      executor: { type: 'worker', id: 'crm-worker', name: 'CRM worker', jobId: '1', attempt: 1 },
    });
    expect(eventSentence(e)).toBe('CRM worker upserted crm contact');
  });
});

describe('humanizeNoun', () => {
  it('splits separators and upper-cases acronyms', () => {
    expect(humanizeNoun('api_key')).toBe('API key');
    expect(humanizeNoun('project.sample_data')).toBe('project sample data');
  });
});
