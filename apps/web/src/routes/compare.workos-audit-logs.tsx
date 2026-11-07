import { createFileRoute } from '@tanstack/react-router';
import { ComparisonPage } from '../components/marketing/comparison-page';
import { getComparison } from '../lib/comparisons';
import { pageHead } from '../lib/seo';

// Copy: marketing/copy/compare/workos-audit-logs.md. Facts: src/lib/comparisons.ts.
export const Route = createFileRoute('/compare/workos-audit-logs')({
  head: () => pageHead('/compare/workos-audit-logs'),
  component: CompareWorkosAuditLogsPage,
});

function CompareWorkosAuditLogsPage() {
  return <ComparisonPage comparison={getComparison('workos-audit-logs')} />;
}
