import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '../components/placeholder-page';
import { pageHead } from '../lib/seo';
export const Route = createFileRoute('/security')({ head: () => pageHead('/security'), component: () => <PlaceholderPage path="/security" /> });
