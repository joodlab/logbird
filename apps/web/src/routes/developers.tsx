import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderPage } from '../components/placeholder-page';
import { pageHead } from '../lib/seo';
export const Route = createFileRoute('/developers')({ head: () => pageHead('/developers'), component: () => <PlaceholderPage path="/developers" /> });
