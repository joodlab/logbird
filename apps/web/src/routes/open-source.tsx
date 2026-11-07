import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '../components/placeholder-page';
import { pageHead } from '../lib/seo';
export const Route = createFileRoute('/open-source')({
  head: () => pageHead('/open-source'),
  component: () => <PlaceholderPage path="/open-source" />,
});
