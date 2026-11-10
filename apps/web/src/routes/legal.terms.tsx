import { createFileRoute } from '@tanstack/react-router';
import { LegalPlaceholder } from '../components/marketing/legal-placeholder';
import { pageHead } from '../lib/seo';

// Copy: marketing/copy/legal-terms.md (summary only; the "must cover" list is for counsel, not the page).
export const Route = createFileRoute('/legal/terms')({
  head: () => pageHead('/legal/terms'),
  component: () => (
    <LegalPlaceholder
      summary="These terms cover use of this website. The Logbird software is licensed separately under the MIT licence, which is included in the repository. Logbird Cloud will have its own terms."
      title="Terms"
    />
  ),
});
