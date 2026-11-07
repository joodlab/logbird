import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '../components/placeholder-page';
import { pageHead } from '../lib/seo';
export const Route = createFileRoute('/compare/retraced')({
  head: () => pageHead('/compare/retraced'),
  component: () => <PlaceholderPage path="/compare/retraced" />,
});
