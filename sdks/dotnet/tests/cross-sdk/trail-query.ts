/**
 * Builds trail queries with the TypeScript SDK's trailQuery and writes them as the golden file the .NET test
 * EventSearchParityTests compares EventSearch.ForTrail against. Run from the repository root:
 *   pnpm exec tsx sdks/dotnet/tests/cross-sdk/trail-query.ts [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { type TrailQuery, trailQuery } from '../../../../packages/sdk/src/read';

const output = 'sdks/dotnet/tests/Logbird.Tests/Fixtures/trail-query.golden.txt';

// Every case is fictional. Values cover tab, newline, carriage return, quote, backslash, colon, star and non-Latin text.
const cases: TrailQuery[] = [
  { target: { id: 'inv_1001' } },
  { target: { type: 'invoice', id: 'inv_1001' } },
  { target: { type: 'invoice', id: 'inv\t1001\nline' } },
  { target: { type: 'note', id: 'carriage\rreturn' } },
  { target: { type: 'quote"type', id: 'a "quoted" id' } },
  { target: { type: 'back\\slash', id: 'c:\\path\\to' } },
  { target: { type: 'ns:kind', id: 'x:y:z' } },
  { target: { type: 'star*', id: 'prefix*' } },
  { target: { type: 'فاتورة', id: 'رقم-١' } },
  { target: { type: '請求書', id: '番号 7 ✓' } },
  { actor: 'user_42' },
  { actor: 'user\t"42"\\*' },
  { tenant: 'acct_*' },
  { tenant: 'شركة\nخيالية' },
  { target: { type: 'invoice', id: 'inv_1' }, actor: 'user_42', tenant: 'acct_7' },
  { q: 'action:invoice.* OR action:payment.*', target: { id: 'inv_1' } },
  { q: 'outcome:failure', target: { type: 'invoice', id: 'inv_1' }, actor: 'u', tenant: 't' },
];

const lines = cases.map((input) => JSON.stringify({ input, q: trailQuery(input).q }));
const golden = `${lines.join('\n')}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== golden) throw new Error(`${output} is stale: run this script without --check`);
  console.log('trail-query.golden.txt matches the TypeScript SDK');
} else {
  writeFileSync(output, golden);
  console.log(`wrote ${output}`);
}
