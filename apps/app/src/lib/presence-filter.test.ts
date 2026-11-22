import { describe, expect, it } from 'vitest';
import { hasPresenceTerm, parsePresenceSql, presenceSqlPredicate, togglePresenceTerm, withPresence } from './presence-filter';

const F = 'impersonator';
const q = (query: string, value: string | null, mode: 'include' | 'exclude') => togglePresenceTerm(query, F, value, mode);
const sql = (query: string, value: string | null, mode: 'include' | 'exclude') => togglePresenceTerm(query, F, value, mode, 'sql');

describe('presence facet, query language', () => {
  it('includes and un-includes any value or one agent', () => {
    expect(q('', null, 'include')).toBe('impersonator:*');
    expect(q('impersonator:*', null, 'include')).toBe('');
    expect(q('', 'support_1', 'include')).toBe('impersonator:support_1');
    expect(q('impersonator:support_1', 'support_1', 'include')).toBe('');
  });

  it('including an agent while support is hidden shows that agent (M1)', () => {
    expect(q('-impersonator:*', 'support_1', 'include')).toBe('impersonator:support_1');
    expect(q('outcome:failure -impersonator:*', 'support_1', 'include')).toBe('outcome:failure impersonator:support_1');
  });

  it('hiding support drops every agent term (M1)', () => {
    expect(q('impersonator:support_1', null, 'exclude')).toBe('-impersonator:*');
    expect(q('impersonator:* -impersonator:support_2', null, 'exclude')).toBe('-impersonator:*');
    expect(q('action:x impersonator:support_1 -impersonator:support_2', null, 'exclude')).toBe('action:x -impersonator:*');
  });

  it('including any agent replaces one agent, and one agent replaces any', () => {
    expect(q('impersonator:support_1', null, 'include')).toBe('impersonator:*');
    expect(q('impersonator:*', 'support_1', 'include')).toBe('impersonator:support_1');
    expect(q('impersonator:support_1', 'support_2', 'include')).toBe('impersonator:support_2');
  });

  it('keeps agent exclusions under "any support agent"', () => {
    expect(q('-impersonator:support_2', null, 'include')).toBe('-impersonator:support_2 impersonator:*');
    expect(q('impersonator:*', 'support_2', 'exclude')).toBe('impersonator:* -impersonator:support_2');
  });

  it('excluding one agent un-hides support and drops that agent', () => {
    expect(q('-impersonator:*', 'support_2', 'exclude')).toBe('-impersonator:support_2');
    expect(q('impersonator:support_2', 'support_2', 'exclude')).toBe('-impersonator:support_2');
    expect(q('-impersonator:support_2', 'support_2', 'exclude')).toBe('');
    expect(q('-impersonator:support_2', 'support_2', 'include')).toBe('impersonator:support_2');
  });

  it('un-hides support', () => {
    expect(q('-impersonator:*', null, 'exclude')).toBe('');
    expect(q('-impersonator:*', null, 'include')).toBe('impersonator:*');
  });

  it('never leaves a contradiction, whatever the order of clicks', () => {
    const values = [null, 'support_1', 'support_2'];
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
    expect(q(s, null, 'exclude')).toBe('-impersonator:*');
  });

  it('narrows to events with an agent, once', () => {
    expect(withPresence('actor:cust_1', F)).toBe('actor:cust_1 impersonator:*');
    expect(withPresence('actor:cust_1 impersonator:*', F)).toBe('actor:cust_1 impersonator:*');
  });

  it('distinguishes a literal star ID from the any-value filter in both languages', () => {
    const exact = String.raw`impersonator:"\*"`;
    expect(q('impersonator:*', '*', 'include')).toBe(exact);
    expect(q(exact, '*', 'include')).toBe('');
    expect(q(exact, null, 'include')).toBe('impersonator:*');
    expect(sql("impersonator_id != ''", '*', 'include')).toBe("impersonator_id = '*'");
    expect(sql("impersonator_id = '*'", null, 'include')).toBe("impersonator_id != ''");
  });
});

describe('presence facet, SQL', () => {
  it('writes and reads predicates', () => {
    expect(presenceSqlPredicate('impersonator_id', { value: null, negated: false })).toBe("impersonator_id != ''");
    expect(presenceSqlPredicate('impersonator_id', { value: null, negated: true })).toBe("impersonator_id = ''");
    expect(presenceSqlPredicate('impersonator_id', { value: "o'neil", negated: true })).toBe("impersonator_id != 'o\\'neil'");
    expect(parsePresenceSql("impersonator_id != ''", 'impersonator_id')).toEqual({ value: null, negated: false });
    expect(parsePresenceSql("impersonator_id=''", 'impersonator_id')).toEqual({ value: null, negated: true });
    expect(parsePresenceSql("impersonator_id <> 'support_1'", 'impersonator_id')).toEqual({ value: 'support_1', negated: true });
    expect(parsePresenceSql("impersonator_id = 'o\\'neil'", 'impersonator_id')).toEqual({ value: "o'neil", negated: false });
    expect(parsePresenceSql("impersonator_name = 'x'", 'impersonator_id')).toBeNull();
  });

  it('includes and un-includes', () => {
    expect(sql('', null, 'include')).toBe("impersonator_id != ''");
    expect(sql("impersonator_id != ''", null, 'include')).toBe('');
    expect(sql('', 'support_1', 'include')).toBe("impersonator_id = 'support_1'");
  });

  it('including an agent while support is hidden shows that agent (M1)', () => {
    expect(sql("impersonator_id = ''", 'support_1', 'include')).toBe("impersonator_id = 'support_1'");
    expect(sql("outcome = 'failure' AND impersonator_id = ''", 'support_1', 'include')).toBe("outcome = 'failure' AND impersonator_id = 'support_1'");
  });

  it('hiding support drops every agent predicate (M1)', () => {
    expect(sql("impersonator_id = 'support_1'", null, 'exclude')).toBe("impersonator_id = ''");
    expect(sql("impersonator_id != '' AND impersonator_id != 'support_2'", null, 'exclude')).toBe("impersonator_id = ''");
  });

  it('one agent and any agent replace each other; exclusions stack under any', () => {
    expect(sql("impersonator_id = 'support_1'", null, 'include')).toBe("impersonator_id != ''");
    expect(sql("impersonator_id != ''", 'support_1', 'include')).toBe("impersonator_id = 'support_1'");
    expect(sql("impersonator_id != ''", 'support_2', 'exclude')).toBe("impersonator_id != '' AND impersonator_id != 'support_2'");
    expect(sql("impersonator_id = ''", 'support_2', 'exclude')).toBe("impersonator_id != 'support_2'");
  });

  it('keeps a top-level OR intact', () => {
    expect(sql("outcome = 'failure' OR outcome = 'denied'", null, 'exclude')).toBe(
      "(outcome = 'failure' OR outcome = 'denied') AND impersonator_id = ''",
    );
  });

  it('never leaves a contradiction', () => {
    const values = [null, 'support_1', 'support_2'];
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

describe('presence filter across OR and groups', () => {
  it('constrains a whole top-level OR when toggled from the sidebar (M1)', () => {
    expect(q('outcome:failure OR outcome:denied', null, 'include')).toBe('(outcome:failure OR outcome:denied) impersonator:*');
    expect(q('outcome:failure OR outcome:denied', null, 'exclude')).toBe('(outcome:failure OR outcome:denied) -impersonator:*');
    expect(q('outcome:failure OR outcome:denied', 'support_1', 'include')).toBe('(outcome:failure OR outcome:denied) impersonator:support_1');
    // Toggling back keeps the user's OR intact.
    expect(q('(outcome:failure OR outcome:denied) impersonator:*', null, 'include')).toBe('(outcome:failure OR outcome:denied)');
  });

  it('counts with a presence filter that constrains the whole query (M1)', () => {
    expect(withPresence('outcome:failure OR outcome:denied', F)).toBe('(outcome:failure OR outcome:denied) impersonator:*');
    // An existing impersonator:* under an OR does not constrain everything.
    expect(withPresence('outcome:failure OR impersonator:*', F)).toBe('(outcome:failure OR impersonator:*) impersonator:*');
    expect(withPresence('(a OR b) impersonator:*', F)).toBe('(a OR b) impersonator:*');
    expect(withPresence("outcome = 'failure' OR outcome = 'denied'", F, 'sql')).toBe(
      "(outcome = 'failure' OR outcome = 'denied') AND impersonator_id != ''",
    );
  });

  it('replaces a hand-written value group with the presence group (m2)', () => {
    expect(q('impersonator:(support_1 OR support_2)', null, 'exclude')).toBe('-impersonator:*');
    expect(q('impersonator:(support_1 OR support_2)', 'support_3', 'include')).toBe('impersonator:support_3');
    expect(q('-impersonator:(support_1 OR support_2)', null, 'include')).toBe('-impersonator:(support_1 OR support_2) impersonator:*');
    // Flat ORs of agents are the same group.
    expect(q('(impersonator:support_1 OR impersonator:support_2) action:x', null, 'exclude')).toBe('action:x -impersonator:*');
  });

  it('reads redundant parentheses in SQL as the same predicate (m2)', () => {
    expect(sql("(impersonator_id = 'support_1')", null, 'exclude')).toBe("impersonator_id = ''");
    expect(sql("((impersonator_id != ''))", null, 'include')).toBe('');
    expect(parsePresenceSql("(impersonator_id = 'a' OR impersonator_id = 'b')", 'impersonator_id')).toBeNull();
    expect(parsePresenceSql("(impersonator_id = 'a)')", 'impersonator_id')).toEqual({ value: 'a)', negated: false });
  });
});

describe('unary NOT on the presence group', () => {
  const authored = 'NOT impersonator:(support_1 OR support_2) action:booking.modified';

  it('reads NOT as an exclusion and removes it with its operand, never negating another predicate', () => {
    // Hide what support did: the NOT group goes with its NOT; the booking filter keeps its polarity.
    expect(q(authored, null, 'exclude')).toBe('action:booking.modified -impersonator:*');
    // Any support agent: the NOT group is an exclusion, kept like any agent exclusion.
    expect(q(authored, null, 'include')).toBe('NOT impersonator:(support_1 OR support_2) action:booking.modified impersonator:*');
    // One agent: exclusions of other agents stay, "NOT" never moves onto action.
    expect(q(authored, 'support_3', 'include')).toBe('NOT impersonator:(support_1 OR support_2) action:booking.modified impersonator:support_3');
    expect(q('NOT impersonator:support_1 action:booking.modified', 'support_1', 'exclude')).toBe('action:booking.modified');
  });

  it('keeps the count query honest under NOT', () => {
    expect(withPresence('NOT impersonator:* action:x', F)).toBe('NOT impersonator:* action:x impersonator:*');
  });
});
