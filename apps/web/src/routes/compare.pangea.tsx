import { createFileRoute } from '@tanstack/react-router';
import { ComparisonPage } from '../components/marketing/comparison-page';
import { getComparison } from '../lib/comparisons';
import { pageHead } from '../lib/seo';

// Copy: marketing/copy/compare/pangea.md. Facts: src/lib/comparisons.ts.
export const Route = createFileRoute('/compare/pangea')({ head: () => pageHead('/compare/pangea'), component: ComparePangeaPage });

function ComparePangeaPage() {
  return <ComparisonPage comparison={getComparison('pangea')} />;
}
