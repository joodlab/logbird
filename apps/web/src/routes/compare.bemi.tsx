import { createFileRoute } from '@tanstack/react-router';
import { CaptureLanes } from '../components/marketing/capture-lanes';
import { ComparisonPage } from '../components/marketing/comparison-page';
import { getComparison } from '../lib/comparisons';
import { pageHead } from '../lib/seo';

// Copy: marketing/copy/compare/bemi.md. Facts: src/lib/comparisons.ts.
export const Route = createFileRoute('/compare/bemi')({ head: () => pageHead('/compare/bemi'), component: CompareBemiPage });

function CompareBemiPage() {
  return <ComparisonPage comparison={getComparison('bemi')} figure={<CaptureLanes />} />;
}
