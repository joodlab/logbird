import { createFileRoute } from '@tanstack/react-router';
import { ComparisonPage } from '../components/marketing/comparison-page';
import { getComparison } from '../lib/comparisons';
import { pageHead } from '../lib/seo';

// Copy: marketing/copy/compare/retraced.md. Facts: src/lib/comparisons.ts.
export const Route = createFileRoute('/compare/retraced')({ head: () => pageHead('/compare/retraced'), component: CompareRetracedPage });

function CompareRetracedPage() {
  return <ComparisonPage comparison={getComparison('retraced')} />;
}
