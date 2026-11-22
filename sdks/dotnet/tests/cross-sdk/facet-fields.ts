/**
 * Writes the contracts' FACETABLE_FIELDS (the stored fields GET /v1/facets accepts) as the golden file the .NET test
 * FacetFieldParityTests compares FacetFields.Named against. Run from the repository root:
 *   pnpm exec tsx sdks/dotnet/tests/cross-sdk/facet-fields.ts [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { FACETABLE_FIELDS } from '../../../../packages/contracts/src/api';

const output = 'sdks/dotnet/tests/Logbird.Tests/Fixtures/facet-fields.golden.txt';
const golden = `${FACETABLE_FIELDS.join('\n')}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== golden) throw new Error(`${output} is stale: run this script without --check`);
  console.log('facet-fields.golden.txt matches the contracts');
} else {
  writeFileSync(output, golden);
  console.log(`wrote ${output}`);
}
