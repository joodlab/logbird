import { createFileRoute } from '@tanstack/react-router';
import { ComparisonPage } from '../components/marketing/comparison-page';
import { getComparison } from '../content/comparisons';
import { pageHead } from '../lib/seo';

// Words: content/comparisons.ts (facts) and content/compare.ts (furniture). Brief: marketing/copy/compare/retraced.md.
export const Route = createFileRoute('/compare/retraced')({ head: () => pageHead('/compare/retraced'), component: CompareRetracedPage });

function CompareRetracedPage() {
  return <ComparisonPage comparison={getComparison('retraced')} />;
}
