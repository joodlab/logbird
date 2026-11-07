import { FileWarningIcon } from 'lucide-react';
import { Callout } from './callout';
import { PageHero } from './section';

/**
 * A legal page while its text is a placeholder (marketing/copy/legal-*.md). The page stays `ready: false` in the site
 * map (noindex, out of the nav, footer and sitemap) until counsel-reviewed text replaces it.
 */
export function LegalPlaceholder({ title, summary }: { title: string; summary: string }) {
  return (
    <>
      <div className="container-site pt-10">
        <Callout icon={<FileWarningIcon className="size-5" />} title="Placeholder">
          To be replaced by counsel-reviewed text before launch.
        </Callout>
      </div>
      <PageHero lead={summary} title={title} />
    </>
  );
}
