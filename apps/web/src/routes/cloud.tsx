import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '../components/placeholder-page';
import { pageHead } from '../lib/seo';
export const Route = createFileRoute('/cloud')({ head: () => pageHead('/cloud'), component: () => <PlaceholderPage path="/cloud" /> });
