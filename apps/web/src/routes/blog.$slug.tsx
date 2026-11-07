import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '../components/placeholder-page';
import { pageHead } from '../lib/seo';
export const Route = createFileRoute('/blog/$slug')({ head: () => pageHead('/blog/$slug'), component: () => <PlaceholderPage path="/blog/$slug" /> });
