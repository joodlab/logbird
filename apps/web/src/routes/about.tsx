import { createFileRoute } from '@tanstack/react-router';
import { ButtonLink } from '../components/marketing/button-link';
import { CtaBand } from '../components/marketing/cta-band';
import { Rich } from '../components/marketing/rich';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { Wordmark } from '../components/marketing/wordmark';
import { GITHUB_PUBLIC, ORG_NAME } from '../env';
import { DESIGN_PARTNER_LINE } from '../lib/copy-flags';
import { pageHead } from '../lib/seo';
import { isReady } from '../lib/site-map';

export const Route = createFileRoute('/about')({ head: () => pageHead('/about'), component: AboutPage });

// Copy: marketing/copy/about.md. Change wording there first. WEB_ORG_NAME controls the company label;
// maintainers keep the published origin story and partner attribution unnamed (see marketing/copy/README.md).
const principles: { title: string; body: string }[] = [
  {
    title: 'Accept anything.',
    body: 'Any JSON object with an `action` is a valid event. We recommend a shape; we never reject an event for missing it.',
  },
  {
    title: "Capture is your code's job.",
    body: 'We give you the SDK, the integrations and the patterns. Our guarantee starts at the `202`.',
  },
  { title: 'History starts when capture starts.', body: "There's no backfill." },
  { title: 'Retention means deletion.', body: 'Expired events are deleted for good.' },
  { title: 'We audit ourselves.', body: "Logbird records its own management actions in your workspace's activity stream." },
];

function AboutPage() {
  return (
    <>
      <PageHero
        actions={
          <>
            <ButtonLink size="lg" to="/product">
              Take the product tour
            </ButtonLink>
            <ButtonLink size="lg" to="/contact" variant="outline">
              Contact us
            </ButtonLink>
          </>
        }
        eyebrow="About"
        lead={
          <>
            {ORG_NAME ? `Logbird is built by ${ORG_NAME}. ` : null}Logbird started as the audit log a product team needed, where every support
            question begins the same way: who changed this, and when? We wanted the answer to take one search, on servers we run ourselves.{' '}
            {GITHUB_PUBLIC
              ? 'We released it under the MIT licence so any product team can do the same.'
              : "It's MIT-licensed, and the source opens publicly soon, so any product team can do the same."}
          </>
        }
        title="We built the audit log we needed."
      />

      <Section labelledBy="partner-title">
        <SectionHeader
          eyebrow="First design partner"
          id="partner-title"
          lead={`${DESIGN_PARTNER_LINE} Integration feedback helps inform the roadmap.`}
          title="Shaped by a real product."
        />
      </Section>

      <Section labelledBy="principles-title" tone="sunken">
        <SectionHeader eyebrow="What we hold to" id="principles-title" title="Five decisions that don't change." />
        <ol className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {principles.map((principle, index) => (
            <li className="panel flex flex-col gap-2 p-5 md:p-6" key={principle.title}>
              <span aria-hidden="true" className="font-mono text-brand text-sm tabular-nums">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="font-semibold text-lg">{principle.title}</h3>
              <p className="text-muted-foreground leading-relaxed">
                <Rich text={principle.body} />
              </p>
            </li>
          ))}
        </ol>
      </Section>

      <Section labelledBy="name-title">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
          <SectionHeader
            eyebrow="The name"
            id="name-title"
            lead="The bird that carries every event home. We chose a short name made of two words you already know, so anyone who hears it once can spell it."
            title="Logbird"
          />
          <div className="panel flex items-center justify-center px-6 py-12">
            <Wordmark className="h-14 w-auto max-w-full" />
          </div>
        </div>
      </Section>

      {isReady('/changelog') ? (
        <Section labelledBy="build-title" tone="sunken">
          <SectionHeader
            eyebrow="Building in public"
            id="build-title"
            lead="We write up what we ship as we go. Every post uses real captures from the product."
            title="Follow the build."
          >
            <div className="flex flex-wrap gap-3 pt-2">
              <ButtonLink to="/changelog">Read the changelog</ButtonLink>
              <ButtonLink to="/contact" variant="outline">
                Contact us
              </ButtonLink>
            </div>
          </SectionHeader>
        </Section>
      ) : null}

      <CtaBand />
    </>
  );
}
