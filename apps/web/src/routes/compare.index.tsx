import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '../components/placeholder-page';
import { pageHead } from '../lib/seo';
export const Route = createFileRoute('/compare/')({ head: () => pageHead('/compare'), component: () => <PlaceholderPage path="/compare" /> });
