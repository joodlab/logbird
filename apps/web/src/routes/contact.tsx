import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '../components/placeholder-page';
import { WaitlistForm } from '../components/waitlist-form';
import { pageHead } from '../lib/seo';
export const Route = createFileRoute('/contact')({
  head: () => pageHead('/contact'),
  validateSearch: (search: Record<string, unknown>) => ({ status: search.status === 'ok' ? 'ok' : search.status === 'error' ? 'error' : undefined }),
  component: ContactPage,
});

function ContactPage() {
  const { status } = Route.useSearch();
  return (
    <>
      <PlaceholderPage path="/contact" />
      <WaitlistForm status={status} />
    </>
  );
}
