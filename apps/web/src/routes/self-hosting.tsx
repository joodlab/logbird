import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '../components/placeholder-page';
import { pageHead } from '../lib/seo';
export const Route = createFileRoute('/self-hosting')({
  head: () => pageHead('/self-hosting'),
  component: () => <PlaceholderPage path="/self-hosting" />,
});
