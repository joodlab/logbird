import type { AuditEvent } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import { mustConfirmSecretClose } from '@/components/one-time-secret';
import { entityViewName } from '@/components/views/save-entity-view-button';
import { ApiRequestError } from './api/errors';
import { actorAttributeHint, outcomeWasSent, parentActor } from './events';
import { sortProjectsByActivity } from './projects';
import { queryProblem, queryProblemText } from './query-error';
import { describeUserAgent } from './user-agent';
import { labelChips, nameableTerms, viewHref } from './views';

const syntax = (q: string, hint: string, start: number) =>
  queryProblem(
    new ApiRequestError(422, 'invalid_query', `Invalid query syntax: ${hint}`, { lang: 'query', reason: 'syntax', start, end: q.length, hint }),
    'query',
  );

describe('OPS-21 query problems in plain language', () => {
  it('explains an unterminated quote with the text it follows, once', () => {
    const q = 'tenant.name:"Bayt Al Rimal';
    const problem = syntax(q, 'Unterminated quoted query', q.indexOf('"'));
    if (!problem) throw new Error('expected a problem');
    const text = queryProblemText(problem, q);
    expect(text).toBe('A quote mark is missing its partner — add a closing " after Bayt Al Rimal.');
    expect(text).not.toContain('Unterminated');
  });

  it('keeps every letter of the quoted text, including lowercase "s", and collapses whitespace only', () => {
    for (const [q, after] of [
      ['tenant.name:"Hassan Suites', 'Hassan Suites'],
      ['action:"booking.status', 'booking.status'],
      ['tenant.name:"Sara   Hassan\tsuites', 'Sara Hassan suites'],
    ] as const) {
      const problem = syntax(q, 'Unterminated quoted query', q.indexOf('"'));
      if (!problem) throw new Error('expected a problem');
      expect(queryProblemText(problem, q)).toBe(`A quote mark is missing its partner — add a closing " after ${after}.`);
    }
    const regex = 'action:/bookings?';
    const problem = syntax(regex, 'Unterminated regex', regex.indexOf('/'));
    if (!problem) throw new Error('expected a problem');
    expect(queryProblemText(problem, regex)).toBe('A /pattern/ is missing its closing slash — add / after bookings?.');
  });

  it('strips the parser prefix even without a space and keeps lowercase "s" in the message', () => {
    const problem = queryProblem(
      new ApiRequestError(422, 'invalid_query', 'Invalid query syntax:status is not a field', {
        lang: 'query',
        reason: 'syntax',
        start: 0,
        end: 6,
        hint: 'status is not a field',
      }),
      'query',
    );
    if (!problem) throw new Error('expected a problem');
    expect(queryProblemText(problem, 'status:x')).toBe('status is not a field');
  });

  it('never repeats the hint, and drops the parser prefix', () => {
    const q = 'action:(a OR';
    const problem = syntax(q, 'Expected )', 7);
    if (!problem) throw new Error('expected a problem');
    expect(queryProblemText(problem, q)).toBe('Expected )');
    const sql = queryProblem(new ApiRequestError(422, 'sql_mode_unavailable', 'SQL mode is not configured on this server.'), 'sql');
    if (!sql) throw new Error('expected a problem');
    expect(queryProblemText(sql, '1')).toBe(
      'SQL mode is not configured on this server. — Switch back to Query mode, or ask an admin to configure the restricted query user.',
    );
  });
});

describe('OPS-22 events that say nothing', () => {
  it('knows when the producer did not send an outcome', () => {
    expect(outcomeWasSent({ action: 'qa.bare' })).toBe(false);
    expect(outcomeWasSent({ action: 'qa.bare', outcome: '' })).toBe(false);
    expect(outcomeWasSent({ action: 'qa.ok', outcome: 'success' })).toBe(true);
    expect(outcomeWasSent(undefined)).toBeNull();
    expect(outcomeWasSent([{ outcome: 'success' }])).toBeNull();
  });

  it('finds who an actor-less event names, without inventing an actor', () => {
    expect(actorAttributeHint({ performed_by: 'Hourly CRM bookings scheduler', 'metadata.channel': 'crm' })).toEqual({
      key: 'performed_by',
      value: 'Hourly CRM bookings scheduler',
    });
    expect(actorAttributeHint({ 'metadata.triggeredBy': 'Nightly import' })).toEqual({ key: 'metadata.triggeredBy', value: 'Nightly import' });
    expect(actorAttributeHint({ 'metadata.channel': 'crm', bypass: 'x' })).toBeNull();
    const actor = (name: string) => ({ actor: { type: 'system', id: name.toLowerCase(), name, email: '' } }) as Pick<AuditEvent, 'actor'>;
    expect(parentActor([actor('Root'), { actor: null }, actor('Scheduler')])?.name).toBe('Scheduler');
    expect(parentActor([actor('Root'), { actor: null }])?.name).toBe('Root');
    expect(parentActor([])).toBeNull();
  });
});

describe('OWNER-11 key last use', () => {
  it('names the client behind the last request', () => {
    expect(describeUserAgent('@logbird/sdk/0.3.0 node/22.18.0')).toBe('@logbird/sdk/0.3.0');
    expect(describeUserAgent('curl/8.4.0')).toBe('curl/8.4.0');
    expect(describeUserAgent('node')).toBe('Node.js');
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('a browser');
    expect(describeUserAgent('')).toBeNull();
    expect(describeUserAgent(null)).toBeNull();
  });
});

describe('OWNER-10 once-only secrets', () => {
  it('asks before a stray gesture closes an uncopied secret', () => {
    for (const reason of ['escape-key', 'outside-press', 'close-press']) {
      expect(mustConfirmSecretClose({ showingSecret: true, copied: false }, reason)).toBe(true);
      expect(mustConfirmSecretClose({ showingSecret: true, copied: true }, reason)).toBe(false);
      expect(mustConfirmSecretClose({ showingSecret: false, copied: false }, reason)).toBe(false);
    }
    // The explicit "I have stored the key" button closes programmatically (no gesture reason).
    expect(mustConfirmSecretClose({ showingSecret: true, copied: false }, undefined)).toBe(false);
  });
});

describe('OPS-19 project order', () => {
  it('puts busy projects first and idle test projects last', () => {
    const p = (name: string, eventsLast24h: number, lastEventAt: string | null) => ({ name, eventsLast24h, lastEventAt });
    const sorted = sortProjectsByActivity([
      p('Search v2 security a 1793859616954', 0, '2026-11-07T10:00:00.000Z'),
      p('Shell QA (empty)', 0, null),
      p('JoodCMS', 5120, '2026-11-08T09:00:00.000Z'),
      p('Ledger demo', 40, '2026-11-08T08:00:00.000Z'),
    ]);
    expect(sorted.map((x) => x.name)).toEqual(['JoodCMS', 'Ledger demo', 'Search v2 security a 1793859616954', 'Shell QA (empty)']);
  });
});

describe('OPS-17/18 saved views', () => {
  it('names a view after the entity and the range', () => {
    expect(entityViewName('Bayt Al Rimal', '7d')).toBe('Bayt Al Rimal — last 7 days');
  });

  it('shows display names for entity terms that are still in the query', () => {
    expect(nameableTerms('tenant:biz_5 outcome:failure -actor:usr_1 target:BK-1 target.type:booking')).toEqual([
      { field: 'tenant', value: 'biz_5' },
      { field: 'target', value: 'BK-1' },
    ]);
    expect(nameableTerms('tenant_id = 1', 'sql')).toEqual([]);
    const labels = [
      { field: 'tenant' as const, value: 'biz_5', label: 'Bayt Al Rimal' },
      { field: 'actor' as const, value: 'usr_9', label: 'Removed from query' },
      { field: 'target' as const, value: 'BK-1', label: 'BK-1' },
    ];
    expect(labelChips('tenant:biz_5 target:BK-1', labels).map((c) => c.text)).toEqual(['Tenant: Bayt Al Rimal']);
    expect(labelChips('tenant:biz_5', undefined)).toEqual([]);
  });

  it('builds a shareable link that reopens the view', () => {
    const href = viewHref('proj_1', { id: 'view_1', state: { q: 'tenant:biz_5', range: '7d' } }, 'https://console.example.test');
    expect(href).toBe('https://console.example.test/p/proj_1/events?q=tenant%3Abiz_5&range=7d&view=view_1');
  });
});
