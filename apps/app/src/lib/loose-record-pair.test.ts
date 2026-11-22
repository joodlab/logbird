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
  // The exact version matches type and id on the same target.
  const exact = loosePairNotice('target:12 target.type:site outcome:failure', 'query')?.exact ?? '';
  expect(compileQuery(exact).params).toMatchObject({ recordType0: 'site', recordId0: '12' });
  expect(compileQuery(exact).sql).toContain('arrayExists((t, i) -> t = {recordType0:String}');
});

it('explains without a button when the pair has no single unambiguous record: form', () => {
  for (const q of [
    'target:12 target:13 target.type:site',
    'target:12 target.type:site target.type:page',
    '-target:12 target.type:site',
    'target:12 -target.type:site',
    'target:12 target.type:site OR outcome:failure',
    '(target:12 target.type:site) outcome:failure',
    'target:1* target.type:site',
    'target:(12 OR 13) target.type:site',
  ])
    expect(loosePairNotice(q, 'query'), q).toEqual({ exact: null });
});

it('says nothing when there is no loose pair', () => {
  for (const q of ['', 'target:12', 'target.type:site', formatRecordTerm('site', '12'), 'outcome:failure', 'actor:u1 tenant:t1'])
    expect(loosePairNotice(q, 'query'), q).toBeNull();
  expect(loosePairNotice("has(target_ids, '12')", 'sql')).toBeNull();
});
