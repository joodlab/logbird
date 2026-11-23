import { createFileRoute } from '@tanstack/react-router';
import { PageHero } from '../components/marketing/section';
import { SecurityContact } from '../components/marketing/security-contact';
import { WaitlistForm } from '../components/waitlist-form';
import { contact } from '../content/contact';
import { shared } from '../content/shared';
import { pageHead } from '../lib/seo';

const INTERESTS = new Set(['cloud', 'self-host', 'updates', 'correction', 'other', 'privacy']);

export const Route = createFileRoute('/contact')({
  head: () => pageHead('/contact'),
  validateSearch: (search: Record<string, unknown>): { status?: string; interest?: string } => ({
    status: typeof search.status === 'string' ? search.status.slice(0, 40) : undefined,
    interest: typeof search.interest === 'string' && INTERESTS.has(search.interest) ? search.interest : undefined,
  }),
  component: ContactPage,
});

// Words: content/contact.ts (the form's own: components/waitlist-form.tsx). This file is layout only.
function ContactPage() {
  const { status, interest } = Route.useSearch();
  const { hero, elsewhere } = contact;
  const { repo } = elsewhere.source;
  return (
    <>
      <PageHero eyebrow={hero.eyebrow} lead={hero.lead} title={hero.title} />
      <section aria-labelledby="waitlist-title" className="py-14 md:py-20">
        <div className="container-site grid gap-12 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="panel p-6 md:p-8">
            <h2 className="mb-6 font-semibold text-xl tracking-[-0.02em]" id="waitlist-title">
              {shared.accessCta}
            </h2>
            <WaitlistForm interest={interest} status={status} />
          </div>
          <aside aria-labelledby="elsewhere-title" className="flex flex-col gap-4">
            <p className="eyebrow">{elsewhere.eyebrow}</p>
            <h2 className="font-semibold text-xl tracking-[-0.02em]" id="elsewhere-title">
              {elsewhere.title}
            </h2>
            <dl className="flex flex-col divide-y text-sm">
              <div className="py-3">
                <dt className="font-medium">{elsewhere.security}</dt>
                <dd className="mt-1 text-muted-foreground leading-relaxed">
                  <SecurityContact onContactPage />
                </dd>
              </div>
              <div className="py-3">
                <dt className="font-medium">{elsewhere.source.title}</dt>
                <dd className="mt-1 text-muted-foreground">
                  {repo ? (
                    <>
                      <a className="text-link" href={repo.href}>
                        {repo.label}
                      </a>
                      {repo.middle}
                      <a className="text-link" href={repo.issuesHref}>
                        {repo.issuesLabel}
                      </a>
                      {repo.end}
                    </>
                  ) : (
                    elsewhere.source.soon
                  )}
                </dd>
              </div>
              {elsewhere.signIn ? (
                <div className="py-3">
                  <dt className="font-medium">{elsewhere.signIn.title}</dt>
                  <dd className="mt-1 text-muted-foreground">
                    <a className="text-link" href={elsewhere.signIn.href}>
                      {elsewhere.signIn.label}
                    </a>
                    {elsewhere.signIn.end}
                  </dd>
                </div>
              ) : null}
            </dl>
          </aside>
        </div>
      </section>
    </>
  );
}
