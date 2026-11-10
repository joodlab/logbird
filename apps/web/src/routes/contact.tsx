import { createFileRoute } from '@tanstack/react-router';
import { PageHero } from '../components/marketing/section';
import { SecurityContact } from '../components/marketing/security-contact';
import { WaitlistForm } from '../components/waitlist-form';
import { GITHUB_PUBLIC, GITHUB_URL } from '../env';
import { ACCESS_CTA, CLOUD_OPEN, SIGN_IN_URL } from '../lib/cloud';
import { pageHead } from '../lib/seo';

const INTERESTS = new Set(['cloud', 'self-host', 'updates', 'correction', 'other']);

export const Route = createFileRoute('/contact')({
  head: () => pageHead('/contact'),
  validateSearch: (search: Record<string, unknown>): { status?: string; interest?: string } => ({
    status: typeof search.status === 'string' ? search.status.slice(0, 40) : undefined,
    interest: typeof search.interest === 'string' && INTERESTS.has(search.interest) ? search.interest : undefined,
  }),
  component: ContactPage,
});

// Copy: marketing/copy/contact.md
function ContactPage() {
  const { status, interest } = Route.useSearch();
  return (
    <>
      <PageHero
        eyebrow="Contact"
        lead={
          CLOUD_OPEN
            ? 'Logbird Cloud is in early access, with sign-ups limited to invited teams. Leave your email to request access. If you have a question about self-hosting, support or something else, choose it below.'
            : "Logbird Cloud isn't open yet. Leave your email and we'll write when it is. If you have a question about self-hosting, support or something else, choose it below."
        }
        title={CLOUD_OPEN ? 'Request access, or ask us anything.' : 'Join the waitlist, or ask us anything.'}
      />
      <section aria-labelledby="waitlist-title" className="py-14 md:py-20">
        <div className="container-site grid gap-12 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="panel p-6 md:p-8">
            <h2 className="mb-6 font-semibold text-xl tracking-[-0.02em]" id="waitlist-title">
              {ACCESS_CTA}
            </h2>
            <WaitlistForm interest={interest} status={status} />
          </div>
          <aside aria-labelledby="elsewhere-title" className="flex flex-col gap-4">
            <p className="eyebrow">Elsewhere</p>
            <h2 className="font-semibold text-xl tracking-[-0.02em]" id="elsewhere-title">
              Other ways to reach us.
            </h2>
            <dl className="flex flex-col divide-y text-sm">
              <div className="py-3">
                <dt className="font-medium">Security issues</dt>
                <dd className="mt-1 text-muted-foreground leading-relaxed">
                  <SecurityContact onContactPage />
                </dd>
              </div>
              <div className="py-3">
                <dt className="font-medium">Source and issues</dt>
                <dd className="mt-1 text-muted-foreground">
                  {GITHUB_PUBLIC && GITHUB_URL ? (
                    <>
                      <a className="text-link" href={GITHUB_URL}>
                        On GitHub
                      </a>
                      : report bugs and ask questions in{' '}
                      <a className="text-link" href={`${GITHUB_URL}/issues`}>
                        issues
                      </a>
                      .
                    </>
                  ) : (
                    'Source on GitHub — coming soon.'
                  )}
                </dd>
              </div>
              {SIGN_IN_URL ? (
                <div className="py-3">
                  <dt className="font-medium">Already invited?</dt>
                  <dd className="mt-1 text-muted-foreground">
                    <a className="text-link" href={SIGN_IN_URL}>
                      Sign in to Logbird Cloud
                    </a>
                    .
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
