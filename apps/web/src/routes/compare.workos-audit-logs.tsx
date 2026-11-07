import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '../components/placeholder-page';
import { pageHead } from '../lib/seo';
export const Route = createFileRoute('/compare/workos-audit-logs')({
  head: () => pageHead('/compare/workos-audit-logs'),
  component: () => <PlaceholderPage path="/compare/workos-audit-logs" />,
});
