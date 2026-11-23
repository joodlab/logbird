import { createFileRoute } from '@tanstack/react-router';
import { CaptureLanes } from '../components/marketing/capture-lanes';
import { ComparisonPage } from '../components/marketing/comparison-page';
import { getComparison } from '../content/comparisons';
import { pageHead } from '../lib/seo';

// Words: content/comparisons.ts (facts) and content/compare.ts (furniture). Brief: marketing/copy/compare/bemi.md.
export const Route = createFileRoute('/compare/bemi')({ head: () => pageHead('/compare/bemi'), component: CompareBemiPage });

function CompareBemiPage() {
  return <ComparisonPage comparison={getComparison('bemi')} figure={<CaptureLanes />} />;
}
