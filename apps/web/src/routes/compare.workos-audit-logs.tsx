import { createFileRoute } from '@tanstack/react-router';
import { ComparisonPage } from '../components/marketing/comparison-page';
import { getComparison } from '../content/comparisons';
import { pageHead } from '../lib/seo';

// Words: content/comparisons.ts (facts) and content/compare.ts (furniture). Brief: marketing/copy/compare/workos-audit-logs.md.
export const Route = createFileRoute('/compare/workos-audit-logs')({
  head: () => pageHead('/compare/workos-audit-logs'),
  component: CompareWorkosAuditLogsPage,
});

function CompareWorkosAuditLogsPage() {
  return <ComparisonPage comparison={getComparison('workos-audit-logs')} />;
}
