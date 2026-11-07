import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '../components/placeholder-page';
import { pageHead } from '../lib/seo';
export const Route = createFileRoute('/compare/pangea')({
  head: () => pageHead('/compare/pangea'),
  component: () => <PlaceholderPage path="/compare/pangea" />,
});
