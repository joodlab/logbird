import { createFileRoute } from '@tanstack/react-router';
import { UseCasePage } from '../components/marketing/use-case';
import { customerAuditLogs } from '../content/use-cases/customer-audit-logs';
import { pageHead } from '../lib/seo';

// Words: content/use-cases/customer-audit-logs.ts. This file is layout only (content-modules.test.ts).
export const Route = createFileRoute('/use-cases/customer-audit-logs')({
  head: () => pageHead('/use-cases/customer-audit-logs'),
  component: () => <UseCasePage page={customerAuditLogs} />,
});
