import { ButtonLink } from './marketing/button-link';
import { LogStack } from './marketing/log-stack';

// Copy: marketing/copy/404.md
export function NotFound() {
  return (
    <>
      <title>Page not found · Logbird</title>
      <meta content="noindex" name="robots" />
      <section className="relative overflow-hidden">
        <div aria-hidden="true" className="ledger-bg pointer-events-none absolute inset-0" />
        <div className="container-site relative grid gap-12 py-20 md:py-28 lg:grid-cols-2 lg:items-center">
          <div className="flex flex-col gap-5">
            <p className="eyebrow">404</p>
            <h1 className="h1">No event at this address.</h1>
            <p className="lead">We searched and found nothing. The page may have moved, or the link may be wrong.</p>
            <p aria-hidden="true" className="w-fit rounded-lg border bg-[var(--surface)] px-3 py-2 font-mono text-muted-foreground text-sm">
              path:"/this-page" <span className="text-[var(--subtle)]">→</span> <span className="text-foreground">0 events</span>
            </p>
            <div className="flex flex-wrap gap-3 pt-2">
              <ButtonLink size="lg" to="/">
                Go to the home page
              </ButtonLink>
              <ButtonLink size="lg" to="/product" variant="outline">
                Product tour
              </ButtonLink>
              <ButtonLink size="lg" to="/developers" variant="ghost">
                Developers
              </ButtonLink>
            </div>
          </div>
          <LogStack animate={false} className="hidden lg:flex" limit={4} />
        </div>
      </section>
    </>
  );
}
