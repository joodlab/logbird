import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '../components/not-found';
import { pageHead } from '../lib/seo';
export const Route = createFileRoute('/404')({
  head: () => ({ ...pageHead('/404'), meta: [...pageHead('/404').meta, { name: 'robots', content: 'noindex' }] }),
  component: NotFound,
});
