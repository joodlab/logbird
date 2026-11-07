import { createFileRoute, Link } from '@tanstack/react-router';
import { CloudIcon, LifeBuoyIcon, ServerIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ButtonLink } from '../components/marketing/button-link';
import { CtaBand } from '../components/marketing/cta-band';
import { type FaqItem, FaqList } from '../components/marketing/faq';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { SelfHostCta } from '../components/marketing/self-host-cta';
import { GITHUB_PUBLIC } from '../env';
import { cx } from '../lib/cx';
import { faqLd, pageHead } from '../lib/seo';
import { getPage } from '../lib/site-map';

// Copy: marketing/copy/cloud.md. Change wording there first. No prices, limits, SLAs or dates on this page.
const privacyReady = getPage('/legal/privacy').ready;

const faq: FaqItem[] = [
  { q: 'When does Logbird Cloud open?', a: "We haven't set a date. People on the waitlist hear first." },
  {
    q: 'Where will my data be stored?',
    a: GITHUB_PUBLIC
      ? "Not decided yet. We'll publish the hosting region before the cloud opens. If your data must stay in a particular place today, self-host Logbird."
      : "Not decided yet. We'll publish the hosting region before the cloud opens. If your data must stay in a particular place, self-hosting is an option once the source opens.",
  },
  {
    q: 'Is the cloud a different product?',
    a: "No. It runs the same codebase as the self-hosted version. One difference is already decided: Logbird Cloud won't offer a free-form SQL console. The guarded SQL WHERE mode in the explorer is in both.",
    body: (
      <>
        No. It runs the same codebase as the self-hosted version. One difference is already decided: Logbird Cloud won't offer a free-form SQL
        console. The guarded SQL <code>WHERE</code> mode in the explorer is in both.
      </>
    ),
  },
  {
    q: 'Can I move between self-host and cloud?',
    a: "We'll document how to migrate before the cloud opens. There's no migration tool today.",
  },
  { q: 'How much will it cost?', a: "Pricing isn't set yet. Self-hosting is free under the MIT licence." },
  { q: 'Will there be an SLA?', a: "We'll publish service levels and limits together with the cloud's launch terms." },
  {
    q: 'What do you do with my waitlist email?',
    // The privacy notice is referenced only once /legal/privacy is ready (site-map), here and in the FAQ JSON-LD.
    a: privacyReady
      ? 'We store it to contact you about Logbird. No trackers. See the privacy notice.'
      : 'We store it to contact you about Logbird. No trackers.',
    body: privacyReady ? (
      <>
        We store it to contact you about Logbird. No trackers. See the{' '}
        <Link className="text-link" to="/legal/privacy">
          privacy notice
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

const plans: {
  id: string;
  name: string;
  status: string;
  body: string;
  icon: ReactNode;
  cta: { label: string; to: string; primary?: boolean; search?: Record<string, string> };
}[] = [
  {
    id: 'self-host',
    name: 'Self-host',
    status: 'Free, MIT',
    body: 'Free and MIT-licensed. Every feature in the repository. You run it.',
    icon: <ServerIcon className="size-4" />,
    // Until the repository is public nobody can self-host: the card leads to the waitlist instead.
    cta: GITHUB_PUBLIC
      ? { label: 'Self-host it', to: '/self-hosting' }
      : { label: 'Self-host when the source opens', to: '/contact', search: { interest: 'self-host' } },
  },
  {
    id: 'cloud',
    name: 'Cloud',
    status: 'Waitlist',
    body: 'We run it for you. Waitlist only for now.',
    icon: <CloudIcon className="size-4" />,
    cta: { label: 'Join the waitlist', to: '/contact', primary: true },
  },
  {
    id: 'support',
    name: 'Support and enterprise',
    status: 'Talk to us',
    body: "For teams that want help running Logbird, or terms we haven't covered here.",
    icon: <LifeBuoyIcon className="size-4" />,
    cta: { label: 'Contact us', to: '/contact' },
  },
];

function StatusPanel() {
  const rows = [
    { label: 'Logbird Cloud', value: 'Not open yet', note: 'Waitlist' },
    { label: 'Pricing', value: "Isn't set yet", note: 'Published before launch' },
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
              Join the waitlist
            </ButtonLink>
            <SelfHostCta />
          </>
        }
        aside={<StatusPanel />}
        eyebrow="Logbird Cloud"
        lead={`Logbird Cloud will run the same open-source codebase you${GITHUB_PUBLIC ? ' can' : "'ll be able to"} self-host. We'll run the servers, the upgrades and the backups. It isn't open yet. Join the waitlist and we'll email you when it is.`}
        title="The same Logbird, run by us."
      />

      <Section id="pricing" labelledBy="pricing-title" tone="sunken">
        <SectionHeader
          eyebrow="Pricing"
          id="pricing-title"
          lead="We'll publish prices before Logbird Cloud opens. Here is the shape we're planning. Nothing here is final."
          title="Pricing isn't set yet."
        />
        <ul className="mt-12 grid gap-4 md:grid-cols-3">
          {plans.map((plan) => (
            <li className={cx('panel flex flex-col gap-5 p-6 md:p-7', plan.cta.primary && 'panel-accent')} key={plan.id}>
              <div className="flex items-center gap-3">
                <span aria-hidden="true" className="inline-flex size-9 items-center justify-center rounded-lg border bg-background text-brand">
                  {plan.icon}
                </span>
                <h3 className="h3">{plan.name}</h3>
              </div>
              <p className="font-semibold text-2xl tracking-tight">{plan.status}</p>
              <p className="text-muted-foreground leading-relaxed">{plan.body}</p>
              <div className="mt-auto pt-2">
                <ButtonLink className="w-full" search={plan.cta.search} to={plan.cta.to} variant={plan.cta.primary ? 'default' : 'outline'}>
                  {plan.cta.label}
                </ButtonLink>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-muted-foreground text-sm">
          Plans, prices and limits will be announced before launch. Nothing on this page is an offer.
        </p>
      </Section>

      <Section id="faq" labelledBy="faq-title">
        <SectionHeader eyebrow="Questions" id="faq-title" title="Cloud questions, answered as far as we can today." />
        <div className="mt-12">
          <FaqList items={faq} />
        </div>
      </Section>

      <CtaBand title="Be first to hear when it opens." />
    </>
  );
}
