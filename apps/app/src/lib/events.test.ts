import type { AuditEvent } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import { actorLabel, causedCount, directChildren, distinctParties, eventSentence, humanizeNoun, partyKey, unlinkedPartyLabel } from './events';

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

const vera = { type: 'user', id: 'usr_vera', name: 'Vera Validator', email: 'vera@logbird.local' };

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
    const joiner = { type: 'user', id: 'eDfVurSJNLRLYBx3fzSXdguaj2B79GOg', name: '', email: 'max@logbird.local' };
    const e = event({ action: 'member.joined_via_link', actor: joiner, targets: [{ type: 'user', id: joiner.id, name: '' }] });
    expect(eventSentence(e)).toBe('max@logbird.local joined via link');
    expect(actorLabel(e)).toBe('max@logbird.local');
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

describe('eventSentence for Logbird management actions', () => {
  const ada = { type: 'user', id: 'usr_ada', name: 'Ada Admin', email: 'ada@logbird.local' };
  const audit = (patch: Partial<AuditEvent>) =>
    event({ actor: ada, executor: { type: 'api', id: 'api-server', name: '', jobId: '', attempt: 0 }, ...patch });

  it('reads a role change from its recorded change', () => {
    const e = audit({
      action: 'member.role.changed',
      description: 'member.role.changed',
      targets: [{ type: 'user', id: 'usr_2', name: 'member2@logbird.local' }],
      changes: [{ field: 'role', before: 'admin', after: 'member' }],
    });
    expect(eventSentence(e)).toBe('Ada Admin changed member2@logbird.local’s role from Admin to Member');
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

it.each([
  ['export.requested', 'Started a CSV export of QA Store (export 12345678)'],
  ['export.completed', 'Exported 205 events from QA Store as CSV (export 12345678)'],
  ['export.failed', 'CSV export of QA Store stopped after 20 events (download canceled) (export 12345678)'],
])('renders the explicit %s export sentence', (action, description) => {
  expect(eventSentence(event({ action, description, actor: vera, targets: [{ type: 'project', id: 'p', name: 'QA Store' }] }))).toBe(description);
});

describe('directChildren', () => {
  const at = (id: string, ts: string, parent?: string) =>
    event({ id, timestamp: ts, context: { operationId: 'op_1', parentEventId: parent ?? '', requestId: '', traceId: '', ip: '', userAgent: '' } });

  it('keeps only events whose parent is the given event, oldest first', () => {
    const events = [
      at('root', '2026-11-05T10:00:00.000Z'),
      at('b', '2026-11-05T10:00:02.000Z', 'root'),
      at('grandchild', '2026-11-05T10:00:03.000Z', 'b'),
      at('a', '2026-11-05T10:00:01.000Z', 'root'),
      at('sibling', '2026-11-05T10:00:01.500Z'),
    ];
    expect(directChildren(events, 'root').map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('orders same-millisecond children by id and ignores a self-reference', () => {
    const events = [
      at('y', '2026-11-05T10:00:01.000Z', 'root'),
      at('x', '2026-11-05T10:00:01.000Z', 'root'),
      at('root', '2026-11-05T10:00:00.000Z', 'root'),
    ];
    expect(directChildren(events, 'root').map((e) => e.id)).toEqual(['x', 'y']);
  });
});

describe('causedCount', () => {
  const ctx = (parentEventId: string) => ({ operationId: '', parentEventId, requestId: '', traceId: '', ip: '', userAgent: '' });

  it('is the stored child count for a normal event', () => {
    expect(causedCount({ childCount: 3 }, { id: 'root', context: ctx('') })).toBe(3);
  });

  it('does not count an event that names itself as its parent', () => {
    expect(causedCount({ childCount: 1 }, { id: 'self', context: ctx('self') })).toBe(0);
    expect(causedCount({ childCount: 4 }, { id: 'self', context: ctx('self') })).toBe(3);
  });
});

describe('directChildren de-duplication', () => {
  it('counts an id stored at two timestamps once, at its earliest time', () => {
    const child = (ts: string) =>
      event({ id: 'c1', timestamp: ts, context: { operationId: 'op', parentEventId: 'root', requestId: '', traceId: '', ip: '', userAgent: '' } });
    expect(directChildren([child('2026-11-05T10:00:02.000Z'), child('2026-11-05T10:00:01.000Z')], 'root').map((e) => e.timestamp)).toEqual([
      '2026-11-05T10:00:01.000Z',
    ]);
  });
});

describe('distinctParties', () => {
  const p = (id: string, type = 'user', name = '') => ({ id, type, name });
  it('keeps each id once, in first-seen order, and skips events that recorded no party', () => {
    expect(distinctParties([p('u1'), null, p('u2'), p('u1'), undefined, p('', '', '')])).toEqual([p('u1'), p('u2')]);
  });
  it('never collapses two different parties recorded without an id', () => {
    const parties = distinctParties([p('', 'worker', 'Billing worker'), p('', 'worker', 'Mailer'), p('', 'user'), p('', 'worker', 'Mailer')]);
    expect(parties).toEqual([p('', 'worker', 'Billing worker'), p('', 'worker', 'Mailer'), p('', 'user')]);
  });
  it('counts five distinct actors as five, so "and 1 more" follows the first four', () => {
    const five = distinctParties([p('a'), p('b'), p('', 'user', 'Lina'), p('c'), p('', 'user', 'Omar'), p('a')]);
    expect(five).toHaveLength(5);
    expect(distinctParties([p('a'), p('b'), p('c'), p('d'), p('d')])).toHaveLength(4);
  });
  it('is empty while there are no events yet', () => {
    expect(distinctParties([])).toEqual([]);
  });
});

describe('unlinkedPartyLabel', () => {
  it('reads the name, else the email, else nothing', () => {
    expect(unlinkedPartyLabel({ name: ' Billing worker ' })).toBe('Billing worker');
    expect(unlinkedPartyLabel({ name: '', email: 'lina@example.test' })).toBe('lina@example.test');
    expect(unlinkedPartyLabel({ name: '' })).toBe('');
  });
});

describe('distinctParties, round 2', () => {
  const p = (id: string, type = 'user', name = '', email = '') => ({ id, type, name, email });
  it('tells ID-less actors apart by email', () => {
    expect(distinctParties([p('', 'user', '', 'a@example.test'), p('', 'user', '', 'b@example.test')])).toHaveLength(2);
  });
  it('reads a repeated id by its latest record, in its first place', () => {
    expect(distinctParties([p('u1'), p('u2', 'user', 'Omar'), p('u1', 'user', 'Lina')])).toEqual([p('u1', 'user', 'Lina'), p('u2', 'user', 'Omar')]);
  });
  it('gives no two different parties the same key, whatever their type and name contain', () => {
    expect(partyKey(p('', 'service:billing', 'west'))).not.toBe(partyKey(p('', 'service', 'billing:west')));
    expect(distinctParties([p('', 'service:billing', 'west'), p('', 'service', 'billing:west')])).toHaveLength(2);
  });
});
