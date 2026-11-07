import { getPage } from '../lib/site-map';
import { ButtonLink } from './marketing/button-link';
import { PageHero } from './marketing/section';

/** Interim body for pages whose design lands in a follow-up PR. Copy lives in marketing/copy/. */
export function PlaceholderPage({ path }: { path: string }) {
  const page = getPage(path);
  return (
    <PageHero
      actions={
        <ButtonLink to="/" variant="outline">
          Back to the overview
        </ButtonLink>
      }
      eyebrow="Coming together"
      lead={page.description}
      title={page.title}
    />
  );
}
