import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '../components/placeholder-page';
import { pageHead } from '../lib/seo';
export const Route = createFileRoute('/legal/terms')({
  head: () => pageHead('/legal/terms'),
  component: () => <PlaceholderPage path="/legal/terms" />,
});
