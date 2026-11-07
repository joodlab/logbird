import { createFileRoute } from '@tanstack/react-router';
import { LegalPlaceholder } from '../components/marketing/legal-placeholder';
import { pageHead } from '../lib/seo';

// Copy: marketing/copy/legal-privacy.md (summary only; the "must cover" list is for counsel, not the page).
export const Route = createFileRoute('/legal/privacy')({
  head: () => pageHead('/legal/privacy'),
  component: () => (
    <LegalPlaceholder
      summary="This website collects the details you type into the waitlist and contact form, and we use them to contact you about Logbird. Like any web server, it also processes your IP address: in memory to rate-limit the form, and it may appear in our host's request logs. The site uses no trackers, no analytics cookies and no third-party advertising scripts."
      title="Privacy"
    />
  ),
});
