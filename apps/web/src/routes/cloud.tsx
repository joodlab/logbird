import { createFileRoute, Link } from '@tanstack/react-router';
import { ButtonLink } from '../components/marketing/button-link';
import { CtaBand } from '../components/marketing/cta-band';
import { type FaqItem, FaqList } from '../components/marketing/faq';
import { PlanCards } from '../components/marketing/plan-cards';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { SelfHostCta } from '../components/marketing/self-host-cta';
import { pricing } from '../content/pricing';
import { GITHUB_PUBLIC } from '../env';
import { ACCESS_CTA, CLOUD_OPEN, SIGN_IN_URL } from '../lib/cloud';
import { faqLd, pageHead } from '../lib/seo';
import { getPage } from '../lib/site-map';

// Copy: marketing/copy/cloud.md. Change wording there first. No prices, limits, SLAs or dates on this page.
const privacyReady = getPage('/legal/privacy').ready;

const faq: FaqItem[] = [
  CLOUD_OPEN
    ? {
        q: 'When can everyone sign up?',
        a: "We haven't set a date. Logbird Cloud is in early access: sign-ups are limited to invited teams while we onboard them. Request access and we'll be in touch.",
      }
    : { q: 'When does Logbird Cloud open?', a: "We haven't set a date. People on the waitlist hear first." },
  {
    q: 'Where will my data be stored?',
    a: CLOUD_OPEN
      ? GITHUB_PUBLIC
        ? "We'll publish the hosting region with the Cloud's launch terms. Ask us before you send production data. If your data must stay in a particular place, self-host Logbird."
        : "We'll publish the hosting region with the Cloud's launch terms. Ask us before you send production data. If your data must stay in a particular place, self-hosting is an option once the source opens."
      : GITHUB_PUBLIC
        ? "Not decided yet. We'll publish the hosting region before the cloud opens. If your data must stay in a particular place today, self-host Logbird."
        : "Not decided yet. We'll publish the hosting region before the cloud opens. If your data must stay in a particular place, self-hosting is an option once the source opens.",
  },
  {
    q: 'Is the cloud a different product?',
    a: `No. It ${CLOUD_OPEN ? 'runs' : 'will run'} the same codebase as the self-hosted version. One difference is already decided: Logbird Cloud won't offer a free-form SQL console. The guarded SQL WHERE mode in the explorer is in both.`,
    body: (
      <>
        No. It {CLOUD_OPEN ? 'runs' : 'will run'} the same codebase as the self-hosted version. One difference is already decided: Logbird Cloud won't
        offer a free-form SQL console. The guarded SQL <code>WHERE</code> mode in the explorer is in both.
      </>
    ),
  },
  {
    q: 'Can I move between self-host and cloud?',
    a: CLOUD_OPEN
      ? "Not with a tool or a guide today. Both run the same codebase, but there's no migration tool and no documented migration path yet."
      : "Not with a tool or a guide. Logbird Cloud will run the same codebase, but there's no migration tool and no documented migration path yet.",
  },
  {
    q: 'How much will it cost?',
    // From content/pricing.ts, so the answer changes with the pricing data.
    a: pricing.cloud.lead,
  },
  {
    q: 'Will there be an SLA?',
    a: CLOUD_OPEN
      ? 'Not during early access. There are no published service levels or limits yet.'
      : 'There are no published service levels or limits yet.',
  },
  {
    q: CLOUD_OPEN ? 'What do you do with the email I give you?' : 'What do you do with my waitlist email?',
    // The privacy notice is referenced only once /legal/privacy is ready (site-map), here and in the FAQ JSON-LD.
    a: privacyReady
      ? 'We store it to contact you about Logbird. No trackers. See the privacy policy.'
      : 'We store it to contact you about Logbird. No trackers.',
    body: privacyReady ? (
      <>
        We store it to contact you about Logbird. No trackers. See the{' '}
        <Link className="text-link" to="/legal/privacy">
          privacy policy
        </Link>
        .
      </>
    ) : undefined,
  },
];

export const Route = createFileRoute('/cloud')({
  head: () => {
    const head = pageHead('/cloud');
    return { ...head, scripts: [...head.scripts, faqLd(faq.map(({ q, a }) => ({ q, a })))] };
  },
  component: CloudPage,
});

function StatusPanel() {
  const rows = [
    CLOUD_OPEN
      ? { label: 'Logbird Cloud', value: 'Early access', note: 'Invited teams' }
      : { label: 'Logbird Cloud', value: 'Not open yet', note: 'Waitlist' },
    pricing.cloud.status,
    GITHUB_PUBLIC
      ? { label: 'Self-host', value: 'Available today', note: 'Free, MIT' }
      : { label: 'Self-host', value: 'When the source opens', note: 'Free, MIT' },
  ];
  return (
    <div className="panel overflow-hidden">
      <p className="border-b bg-[var(--surface-sunken)] px-5 py-3 font-mono text-muted-foreground text-xs uppercase tracking-wider">
        Where things stand
      </p>
      <dl>
        {rows.map((row) => (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b px-5 py-4 last:border-b-0" key={row.label}>
            <dt className="font-medium">{row.label}</dt>
            <dd className="text-end">
              <span className="block font-medium">{row.value}</span>
              <span className="block text-muted-foreground text-sm">{row.note}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function CloudPage() {
  return (
    <>
      <PageHero
        actions={
          <>
            <ButtonLink size="lg" to="/contact">
              {ACCESS_CTA}
            </ButtonLink>
            {SIGN_IN_URL ? (
              <ButtonLink href={SIGN_IN_URL} size="lg" variant="outline">
                Sign in
              </ButtonLink>
            ) : (
              <SelfHostCta />
            )}
          </>
        }
        aside={<StatusPanel />}
        eyebrow="Logbird Cloud"
        lead={
          CLOUD_OPEN
            ? `Logbird Cloud runs the same ${GITHUB_PUBLIC ? 'open-source codebase you can' : "codebase you'll be able to"} self-host. We run the servers, the upgrades and the backups. It's in early access: sign-ups are limited to invited teams for now. Request access, or sign in if you've been invited.`
            : `Logbird Cloud will run the same ${GITHUB_PUBLIC ? 'open-source codebase you can' : "codebase you'll be able to"} self-host. We'll run the servers, the upgrades and the backups. It isn't open yet. Join the waitlist and we'll email you when it is.`
        }
        title="The same Logbird, run by us."
      />

      <Section id="pricing" labelledBy="pricing-title" tone="sunken">
        <SectionHeader eyebrow={pricing.cloud.eyebrow} id="pricing-title" lead={pricing.cloud.lead} title={pricing.cloud.title} />
        <div className="mt-12">
          <PlanCards dimensions={pricing.dimensions} plans={pricing.plans} />
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
          <ButtonLink to={pricing.cloud.more.to} variant="outline">
            {pricing.cloud.more.label}
          </ButtonLink>
          <p className="text-muted-foreground text-sm">{pricing.cloud.note}</p>
        </div>
      </Section>

      <Section id="faq" labelledBy="faq-title">
        <SectionHeader eyebrow="Questions" id="faq-title" title="Cloud questions, answered as far as we can today." />
        <div className="mt-12">
          <FaqList items={faq} />
        </div>
      </Section>

      <CtaBand title={CLOUD_OPEN ? 'Want early access?' : 'Be first to hear when it opens.'} />
    </>
  );
}
