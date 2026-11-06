import { QUERY_FIELDS, queryErrorDetailsSchema } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import { compileQuery, parseQuery, QueryError } from './query';

describe('v2', () => {
  it.each([
    'attempt:>2',
    'attempt:>=2',
    'conformance:<50',
    'attempt:<=3',
    'duration_ms:[100 TO 500]',
    'duration_ms:{100 TO 500}',
    'duration_ms:[100 TO 500}',
    'duration_ms:[* TO 500]',
    'duration_ms:[100 TO *]',
    'occurredAt:>2026-11-01',
    'occurredAt:[2026-11-01 TO 2026-11-03T12:00:00Z]',
    'action:/booking\\.(created|cancelled)/',
    'action:(booking.created OR booking.cancelled)',
    '-outcome:(failure OR denied)',
    'action:(booking.* OR hotel.*)',
    'metadata.channel:whatsapp',
    'attributes.foo.bar:x',
    'a AND b',
    'NOT a',
    'target.name:/A.*/',
    'changes.field:status',
    'attr.date:>=2026-11-01',
    'attr.n:>-2',
  ])('compiles %s', (q) => {
    expect(compileQuery(q).sql).toBeTruthy();
  });
  it.each(QUERY_FIELDS.flatMap((f) => [f.key, ...(f.aliases ?? [])].map((k) => ({ k, f }))))('catalog $k', ({ k, f }) => {
    expect(compileQuery(`${k}:*`).sql).toContain(f.type === 'number' || f.type === 'date' ? '1' : f.column);
  });
  it.each([
    ['attempt:>abc', 'type', 9, 12],
    ['occurredAt:>2026-13-45', 'type', 12, 22],
    ['action:(a OR', 'syntax', 12, 12],
    ['x:[1 TO]', 'syntax', 7, 8],
    ['"unterminated', 'syntax', 0, 13],
    ['a OR OR b', 'syntax', 5, 7],
    ['(a b', 'syntax', 4, 4],
    ['/[unclosed/', 'type', 0, 11],
    ['\u0645\u0631\u062d\u0628\u0627 attempt:>abc', 'type', 15, 18],
  ] as const)('diagnoses %s', (q, reason, start, end) => {
    try {
      compileQuery(q);
      throw new Error('accepted');
    } catch (e) {
      expect(e).toBeInstanceOf(QueryError);
      const d = queryErrorDetailsSchema.parse((e as QueryError).details);
      expect(d).toMatchObject({ lang: 'query', reason, start, end });
    }
  });
  it('rejects RE2 repetition overflow without executing the regex', () => expect(() => compileQuery('action:/a{1001}/')).toThrow());
  it('spans use UTF-16', () => {
    expect(parseQuery('\u{1F600} action:x')[0]).toMatchObject({ start: 0, end: 2 });
  });
  it('regex escapes and anchoring stay bound', () => {
    const c = compileQuery(String.raw`action:/a\/b/`);
    expect(Object.values(c.params)).toContain('^(?:a/b)$');
    expect(c.sql).not.toContain('a/b');
  });
  it.each(['x '.repeat(65), `${'('.repeat(17)}x${')'.repeat(17)}`, '\u00e9'.repeat(2049)])('enforces complexity', (q) =>
    expect(() => compileQuery(q)).toThrow(),
  );
  it.each([
    'action:hotel.policy.updated',
    'action:hotel.*',
    'outcome:failure -env:staging',
    'actor:usr_42 actor.type:user actor.name:"Raed B"',
    'tenant:biz_7 tenant.name:"Azure Hotels" executor:crm-worker executor.type:worker',
    'executor.name:"CRM worker" actor.email:raed@example.com impersonator:usr_1',
    'parent:evt_123 job:456',
    'target:hotel_123 target.type:hotel operation:op_101 request:req_abc trace:abc source:joodbooking',
    'attr.metadata.plan:pro',
    'impersonator:* -tenant:*',
    'severity:critical category:hotel id:evt',
    '"free text" bare words',
    'a OR b',
    '(a OR b) c',
  ])('keeps spec v0 %s', (q) => expect(compileQuery(q).sql).toBeTruthy());
});
