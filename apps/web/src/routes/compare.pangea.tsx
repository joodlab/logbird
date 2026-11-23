import { createFileRoute } from '@tanstack/react-router';
import { ComparisonPage } from '../components/marketing/comparison-page';
import { getComparison } from '../content/comparisons';
import { pageHead } from '../lib/seo';

// Words: content/comparisons.ts (facts) and content/compare.ts (furniture). Brief: marketing/copy/compare/pangea.md.
export const Route = createFileRoute('/compare/pangea')({ head: () => pageHead('/compare/pangea'), component: ComparePangeaPage });

function ComparePangeaPage() {
  return <ComparisonPage comparison={getComparison('pangea')} />;
}
