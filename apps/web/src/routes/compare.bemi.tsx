import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '../components/placeholder-page';
import { pageHead } from '../lib/seo';
export const Route = createFileRoute('/compare/bemi')({
  head: () => pageHead('/compare/bemi'),
  component: () => <PlaceholderPage path="/compare/bemi" />,
});
