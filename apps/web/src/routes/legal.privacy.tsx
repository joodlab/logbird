import { createFileRoute } from '@tanstack/react-router';
import { LegalPlaceholder } from '../components/marketing/legal-placeholder';
import { pageHead } from '../lib/seo';

// Copy: marketing/copy/legal-privacy.md (summary only; the "must cover" list is for counsel, not the page).
export const Route = createFileRoute('/legal/privacy')({
  head: () => pageHead('/legal/privacy'),
  component: () => (
    <LegalPlaceholder
      summary="This website collects one thing: the details you type into the waitlist and contact form. We use them to contact you about Logbird. The site uses no trackers, no analytics cookies and no third-party advertising scripts."
      title="Privacy"
    />
  ),
});
