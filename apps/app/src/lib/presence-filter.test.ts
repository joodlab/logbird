import { describe, expect, it } from 'vitest';
import { hasPresenceTerm, parsePresenceSql, presenceSqlPredicate, togglePresenceTerm, withPresence } from './presence-filter';

const F = 'impersonator';
const q = (query: string, value: string, mode: 'include' | 'exclude') => togglePresenceTerm(query, F, value, mode);
const sql = (query: string, value: string, mode: 'include' | 'exclude') => togglePresenceTerm(query, F, value, mode, 'sql');

describe('presence facet, query language', () => {
  it('includes and un-includes any value or one agent', () => {
    expect(q('', '*', 'include')).toBe('impersonator:*');
    expect(q('impersonator:*', '*', 'include')).toBe('');
    expect(q('', 'support_1', 'include')).toBe('impersonator:support_1');
    expect(q('impersonator:support_1', 'support_1', 'include')).toBe('');
  });

  it('including an agent while support is hidden shows that agent (M1)', () => {
    expect(q('-impersonator:*', 'support_1', 'include')).toBe('impersonator:support_1');
    expect(q('outcome:failure -impersonator:*', 'support_1', 'include')).toBe('outcome:failure impersonator:support_1');
  });

  it('hiding support drops every agent term (M1)', () => {
    expect(q('impersonator:support_1', '*', 'exclude')).toBe('-impersonator:*');
    expect(q('impersonator:* -impersonator:support_2', '*', 'exclude')).toBe('-impersonator:*');
    expect(q('action:x impersonator:support_1 -impersonator:support_2', '*', 'exclude')).toBe('action:x -impersonator:*');
  });

  it('including any agent replaces one agent, and one agent replaces any', () => {
    expect(q('impersonator:support_1', '*', 'include')).toBe('impersonator:*');
    expect(q('impersonator:*', 'support_1', 'include')).toBe('impersonator:support_1');
    expect(q('impersonator:support_1', 'support_2', 'include')).toBe('impersonator:support_2');
  });

  it('keeps agent exclusions under "any support agent"', () => {
    expect(q('-impersonator:support_2', '*', 'include')).toBe('-impersonator:support_2 impersonator:*');
    expect(q('impersonator:*', 'support_2', 'exclude')).toBe('impersonator:* -impersonator:support_2');
  });

  it('excluding one agent un-hides support and drops that agent', () => {
    expect(q('-impersonator:*', 'support_2', 'exclude')).toBe('-impersonator:support_2');
    expect(q('impersonator:support_2', 'support_2', 'exclude')).toBe('-impersonator:support_2');
    expect(q('-impersonator:support_2', 'support_2', 'exclude')).toBe('');
    expect(q('-impersonator:support_2', 'support_2', 'include')).toBe('impersonator:support_2');
  });

  it('un-hides support', () => {
    expect(q('-impersonator:*', '*', 'exclude')).toBe('');
    expect(q('-impersonator:*', '*', 'include')).toBe('impersonator:*');
  });

  it('never leaves a contradiction, whatever the order of clicks', () => {
    const values = ['*', 'support_1', 'support_2'];
    const modes = ['include', 'exclude'] as const;
    let states = [''];
    for (let depth = 0; depth < 3; depth++) {
      states = states.flatMap((s) => values.flatMap((v) => modes.map((m) => q(s, v, m))));
      for (const s of states) {
        const hidden = s.includes('-impersonator:*');
        const positive = /(^|\s)impersonator:/.test(s);
        expect(hidden && positive, s).toBe(false);
        expect((s.match(/(^|\s)impersonator:/g) ?? []).length, s).toBeLessThanOrEqual(1);
      }
    }
  });

  it('quotes values that need it and reads them back', () => {
    const s = q('', 'Hana Calder', 'include');
    expect(s).toBe('impersonator:"Hana Calder"');
    expect(hasPresenceTerm(s, F, { value: 'Hana Calder', negated: false })).toBe(true);
    expect(q(s, '*', 'exclude')).toBe('-impersonator:*');
  });

  it('narrows to events with an agent, once', () => {
    expect(withPresence('actor:cust_1', F)).toBe('actor:cust_1 impersonator:*');
    expect(withPresence('actor:cust_1 impersonator:*', F)).toBe('actor:cust_1 impersonator:*');
  });
});

describe('presence facet, SQL', () => {
  it('writes and reads predicates', () => {
    expect(presenceSqlPredicate('impersonator_id', { value: '*', negated: false })).toBe("impersonator_id != ''");
    expect(presenceSqlPredicate('impersonator_id', { value: '*', negated: true })).toBe("impersonator_id = ''");
    expect(presenceSqlPredicate('impersonator_id', { value: "o'neil", negated: true })).toBe("impersonator_id != 'o\\'neil'");
    expect(parsePresenceSql("impersonator_id != ''", 'impersonator_id')).toEqual({ value: '*', negated: false });
    expect(parsePresenceSql("impersonator_id=''", 'impersonator_id')).toEqual({ value: '*', negated: true });
    expect(parsePresenceSql("impersonator_id <> 'support_1'", 'impersonator_id')).toEqual({ value: 'support_1', negated: true });
    expect(parsePresenceSql("impersonator_id = 'o\\'neil'", 'impersonator_id')).toEqual({ value: "o'neil", negated: false });
    expect(parsePresenceSql("impersonator_name = 'x'", 'impersonator_id')).toBeNull();
  });

  it('includes and un-includes', () => {
    expect(sql('', '*', 'include')).toBe("impersonator_id != ''");
    expect(sql("impersonator_id != ''", '*', 'include')).toBe('');
    expect(sql('', 'support_1', 'include')).toBe("impersonator_id = 'support_1'");
  });

  it('including an agent while support is hidden shows that agent (M1)', () => {
    expect(sql("impersonator_id = ''", 'support_1', 'include')).toBe("impersonator_id = 'support_1'");
    expect(sql("outcome = 'failure' AND impersonator_id = ''", 'support_1', 'include')).toBe("outcome = 'failure' AND impersonator_id = 'support_1'");
  });

  it('hiding support drops every agent predicate (M1)', () => {
    expect(sql("impersonator_id = 'support_1'", '*', 'exclude')).toBe("impersonator_id = ''");
    expect(sql("impersonator_id != '' AND impersonator_id != 'support_2'", '*', 'exclude')).toBe("impersonator_id = ''");
  });

  it('one agent and any agent replace each other; exclusions stack under any', () => {
    expect(sql("impersonator_id = 'support_1'", '*', 'include')).toBe("impersonator_id != ''");
    expect(sql("impersonator_id != ''", 'support_1', 'include')).toBe("impersonator_id = 'support_1'");
    expect(sql("impersonator_id != ''", 'support_2', 'exclude')).toBe("impersonator_id != '' AND impersonator_id != 'support_2'");
    expect(sql("impersonator_id = ''", 'support_2', 'exclude')).toBe("impersonator_id != 'support_2'");
  });

  it('keeps a top-level OR intact', () => {
    expect(sql("outcome = 'failure' OR outcome = 'denied'", '*', 'exclude')).toBe(
      "(outcome = 'failure' OR outcome = 'denied') AND impersonator_id = ''",
    );
  });

  it('never leaves a contradiction', () => {
    const values = ['*', 'support_1', 'support_2'];
    const modes = ['include', 'exclude'] as const;
    let states = [''];
    for (let depth = 0; depth < 3; depth++) {
      states = states.flatMap((s) => values.flatMap((v) => modes.map((m) => sql(s, v, m))));
      for (const s of states) {
        const hidden = /impersonator_id = ''/.test(s);
        const positive = /impersonator_id = '[^']/.test(s) || /impersonator_id != ''/.test(s);
        expect(hidden && positive, s).toBe(false);
      }
    }
  });

  it('narrows to events with an agent', () => {
    expect(withPresence("actor_id = 'cust_1'", F, 'sql')).toBe("actor_id = 'cust_1' AND impersonator_id != ''");
    expect(withPresence('', F, 'sql')).toBe("impersonator_id != ''");
  });
});
