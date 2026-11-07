import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '../components/placeholder-page';
import { pageHead } from '../lib/seo';
export const Route = createFileRoute('/legal/privacy')({
  head: () => pageHead('/legal/privacy'),
  component: () => <PlaceholderPage path="/legal/privacy" />,
});
