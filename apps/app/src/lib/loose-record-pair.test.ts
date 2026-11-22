import { compileQuery } from '@logbird/clickhouse';
import { formatRecordTerm } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { loosePairNotice } from './views';

it('explains a loose record pair and offers its exact record: form, from the query shape alone', () => {
  const record = formatRecordTerm('site', '12');
  // What old record pages saved, or a reader typed: the same statement is true for both.
  expect(loosePairNotice('target:12 target.type:site', 'query')).toEqual({ exact: record });
  expect(loosePairNotice('target:12 AND target.type:site', 'query')).toEqual({ exact: record });
  expect(loosePairNotice('target.type:site target:12', 'query')).toEqual({ exact: record });
  // Other filters are kept, ANDed with the exact pair.
  expect(loosePairNotice('target:12 target.type:site outcome:failure', 'query')).toEqual({ exact: `${record} outcome:failure` });
  expect(loosePairNotice('target:"a b" target.type:"x:y"', 'query')).toEqual({ exact: formatRecordTerm('x:y', 'a b') });
  // An empty quoted id is a real value: record:"site:" matches type site with the empty id.
  expect(loosePairNotice('target:"" target.type:site', 'query')).toEqual({ exact: formatRecordTerm('site', '') });
  expect(loosePairNotice('target:12 target.type:""', 'query')).toEqual({ exact: formatRecordTerm('', '12') });
  // Every exact version matches type and id on the same target.
  for (const [q, type, id] of [
    ['target:12 target.type:site', 'site', '12'],
    ['target:12 AND target.type:site', 'site', '12'],
    ['target.type:site target:12', 'site', '12'],
    ['target:12 target.type:site outcome:failure', 'site', '12'],
    ['target:12 target.type:site (outcome:failure OR action:x)', 'site', '12'],
    ['target:"a b" target.type:"x:y"', 'x:y', 'a b'],
    ['target:"" target.type:site', 'site', ''],
    ['target:12 target.type:""', '', '12'],
  ] as const) {
    const exact = loosePairNotice(q, 'query')?.exact ?? '';
    const compiled = compileQuery(exact);
    expect(compiled.params, q).toMatchObject({ recordType0: type, recordId0: id });
    expect(compiled.sql, q).toContain('arrayExists((t, i) -> t = {recordType0:String}');
    // No separate type check that could sit on another target.
    expect(compiled.sql, q).not.toContain('has(target_types');
  }
});

it('explains without a button when the pair has no single unambiguous record: form', () => {
  for (const q of [
    'target:12 target:13 target.type:site',
    'target:12 target.type:site target.type:page',
    'target:12 target.type:site OR outcome:failure',
    'target:12 OR target.type:site',
    'target:1* target.type:site',
  ])
    expect(loosePairNotice(q, 'query'), q).toEqual({ exact: null });
});

it('says nothing when there is no loose pair', () => {
  for (const q of [
    '',
    'target:12',
    'target.type:site',
    formatRecordTerm('site', '12'),
    'outcome:failure',
    'actor:u1 tenant:t1',
    // Presence checks select no id or type.
    '_exists_:target _exists_:target.type',
    'target:* target.type:*',
    // Excluding both cannot include another record that shares them.
    '-target:12 -target.type:site',
    'target:12 -target.type:site',
    '-target:12 target.type:site',
    // Inside a group, a negation or OR can change what the terms mean: nothing is claimed.
    '-(target:12 OR target.type:site)',
    'NOT (target:12 target.type:site)',
    '(target:12 target.type:site) outcome:failure',
    // Value groups (including presence inside one) are not single values.
    'target:(*) target.type:(*)',
    'target:(12 OR 13) target.type:site',
  ])
    expect(loosePairNotice(q, 'query'), q).toBeNull();
  expect(loosePairNotice("has(target_ids, '12')", 'sql')).toBeNull();
});
