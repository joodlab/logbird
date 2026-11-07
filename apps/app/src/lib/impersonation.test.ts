import { describe, expect, it } from 'vitest';
import { jobHint, supportAgentName, supportAgentQuery, supportPhrase, whoFilter, withWhoFilter } from './impersonation';

const executor = (over: Partial<{ type: string; id: string; name: string; jobId: string; attempt: number }> = {}) => ({
  executor: { type: 'worker', id: 'billing-worker', name: '', jobId: '', attempt: 0, ...over },
});

describe('support agent', () => {
  it('names the agent, falling back to the id', () => {
    expect(supportAgentName({ impersonator: { id: 'support_2', name: 'Yusuf Varma' } })).toBe('Yusuf Varma');
    expect(supportAgentName({ impersonator: { id: 'support_2', name: '' } })).toBe('support_2');
    expect(supportAgentName({ impersonator: null })).toBeNull();
  });

  it('builds the agent query, quoting ids that need it', () => {
    expect(supportAgentQuery('support_2')).toBe('impersonator:support_2');
    expect(supportAgentQuery('Hana Calder')).toBe('impersonator:"Hana Calder"');
  });
});

describe('who did it', () => {
  it('reads the split from the query', () => {
    expect(whoFilter('')).toBe('all');
    expect(whoFilter('outcome:failure impersonator:*')).toBe('support');
    expect(whoFilter('-impersonator:* action:booking.modified')).toBe('self');
    // One agent is a subset of support; agent exclusions alone are still "everything".
    expect(whoFilter('impersonator:support_2')).toBe('support');
    expect(whoFilter('-impersonator:support_2')).toBe('all');
    expect(whoFilter("impersonator_id != ''", 'sql')).toBe('support');
    expect(whoFilter("outcome = 'failure' AND impersonator_id = ''", 'sql')).toBe('self');
    expect(whoFilter("impersonator_id = 'support_2'", 'sql')).toBe('support');
    expect(whoFilter("outcome = 'failure'", 'sql')).toBe('all');
  });

  it('drops specific agents with the split, so the timeline never contradicts itself (M1)', () => {
    expect(withWhoFilter('actor:cust_1 impersonator:support_1', 'self')).toBe('actor:cust_1 -impersonator:*');
    expect(withWhoFilter('impersonator:support_1', 'support')).toBe('impersonator:*');
    expect(withWhoFilter('impersonator:support_1 -impersonator:support_2', 'support')).toBe('-impersonator:support_2 impersonator:*');
    expect(withWhoFilter('impersonator:support_1 -impersonator:support_2', 'all')).toBe('');
    expect(withWhoFilter('-impersonator:support_2', 'self')).toBe('-impersonator:*');
  });

  it('swaps the split in SQL', () => {
    expect(withWhoFilter("outcome = 'failure'", 'support', 'sql')).toBe("outcome = 'failure' AND impersonator_id != ''");
    expect(withWhoFilter("outcome = 'failure' AND impersonator_id = 'support_1'", 'self', 'sql')).toBe(
      "outcome = 'failure' AND impersonator_id = ''",
    );
    expect(withWhoFilter("impersonator_id = '' AND outcome = 'failure'", 'all', 'sql')).toBe("outcome = 'failure'");
  });

  it('swaps the split and keeps every other term', () => {
    expect(withWhoFilter('outcome:failure', 'support')).toBe('outcome:failure impersonator:*');
    expect(withWhoFilter('outcome:failure impersonator:*', 'self')).toBe('outcome:failure -impersonator:*');
    expect(withWhoFilter('-impersonator:* outcome:failure', 'all')).toBe('outcome:failure');
    expect(withWhoFilter('', 'self')).toBe('-impersonator:*');
    expect(whoFilter(withWhoFilter('action:x', 'support'))).toBe('support');
  });
});

describe('supportPhrase', () => {
  it('says who was at the keyboard and whose account it was', () => {
    expect(
      supportPhrase({ impersonator: { id: 'support_1', name: 'Leena Ashford' }, actor: { type: 'user', id: 'u1', name: 'Rohan Mehta', email: '' } }),
    ).toBe('done by support agent Leena Ashford while acting as Rohan Mehta');
    expect(supportPhrase({ impersonator: { id: 'support_1', name: '' }, actor: null })).toBe(
      'done by support agent support_1 while acting as an unknown customer',
    );
    expect(supportPhrase({ impersonator: null, actor: null })).toBeNull();
  });
});

describe('jobHint', () => {
  it('stays out of interactive rows', () => {
    expect(jobHint({ executor: null })).toBeNull();
    expect(jobHint(executor())).toBeNull();
    expect(jobHint(executor({ attempt: 1 }))).toBeNull();
  });

  it('names the executor and the try for job rows', () => {
    expect(jobHint(executor({ jobId: 'job_42', attempt: 2, name: 'Billing worker' }))).toEqual({
      executor: 'Billing worker',
      attempt: 2,
      jobId: 'job_42',
      label: 'Background job job_42, run by Billing worker, try 2',
    });
    // A retry without a job id still counts.
    expect(jobHint(executor({ attempt: 3 }))?.label).toBe('Background job, run by billing-worker, try 3');
  });
});
