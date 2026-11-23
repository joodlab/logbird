// This file is the root route's first import. Its first imports must stay the shared ButtonLink and LogStack modules: if
// a module of the entry chunk runs before them (the sorted order puts ../content first), rolldown folds their chunks into
// the entry and every page's preload list changes.
// biome-ignore assist/source/organizeImports: the words load after the shared components, keeping the chunk graph
import { ButtonLink } from './marketing/button-link';
import { LogStack } from './marketing/log-stack';
import { notFoundPage } from '../content/not-found';

// Words: content/not-found.ts (brief: marketing/copy/404.md). This file is layout only (content-modules.test.ts).
export function NotFound() {
  const { search, actions } = notFoundPage;
  return (
    <>
      <title>{notFoundPage.documentTitle}</title>
      <meta content="noindex" name="robots" />
      <section className="relative overflow-hidden">
        <div aria-hidden="true" className="ledger-bg pointer-events-none absolute inset-0" />
        <div className="container-site relative grid gap-12 py-20 md:py-28 lg:grid-cols-2 lg:items-center">
          <div className="flex flex-col gap-5">
            <p className="eyebrow">{notFoundPage.eyebrow}</p>
            <h1 className="h1">{notFoundPage.title}</h1>
            <p className="lead">{notFoundPage.lead}</p>
            <p aria-hidden="true" className="w-fit rounded-lg border bg-[var(--surface)] px-3 py-2 font-mono text-muted-foreground text-sm">
              {search.query} <span className="text-[var(--subtle)]">{search.arrow}</span> <span className="text-foreground">{search.result}</span>
            </p>
            <div className="flex flex-wrap gap-3 pt-2">
              <ButtonLink size="lg" to="/">
                {actions.home}
              </ButtonLink>
              <ButtonLink size="lg" to="/product" variant="outline">
                {actions.product}
              </ButtonLink>
              <ButtonLink size="lg" to="/developers" variant="ghost">
                {actions.developers}
              </ButtonLink>
            </div>
          </div>
          <LogStack animate={false} className="hidden lg:flex" limit={4} />
        </div>
      </section>
    </>
  );
}
