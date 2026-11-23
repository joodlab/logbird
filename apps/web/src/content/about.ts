import { ORG_NAME } from '../env';
import { DESIGN_PARTNER_LINE } from '../lib/copy-flags';
import { byRepo, SITE } from './site';

/**
 * Words of /about. Brief: marketing/copy/about.md. WEB_ORG_NAME controls the company label; maintainers keep the
 * published origin story and partner attribution unnamed (see marketing/copy/README.md). Inline marks: `code`.
 */
export const about = {
  hero: {
    eyebrow: 'About',
    title: 'We built the audit log we needed.',
    lead: `${ORG_NAME ? `Logbird is built by ${ORG_NAME}. ` : ''}Logbird started as the audit log a product team needed, where every support question begins the same way: who changed this, and when? We wanted the answer to take one search, on servers we run ourselves. ${byRepo(
      SITE,
      {
        public: 'We released it under the MIT licence so any product team can do the same.',
        private: "It's MIT-licensed, and the source opens publicly soon, so any product team can do the same.",
      },
    )}`,
    tourAction: 'Take the product tour',
    contactAction: 'Contact us',
  },
  partner: {
    eyebrow: 'First design partner',
    title: 'Shaped by a real product.',
    lead: `${DESIGN_PARTNER_LINE} Integration feedback helps inform the roadmap.`,
  },
  principles: {
    eyebrow: 'What we hold to',
    title: "Five decisions that don't change.",
    items: [
      {
        title: 'Require only an action.',
        body: 'An `action` string is the only required field, and each event must fit the ingest limits. We recommend a shape; we never reject an event for missing it.',
      },
      {
        title: "Capture is your code's job.",
        body: 'We give you the SDK, the integrations and the patterns. Our guarantee starts at the `202`.',
      },
      {
        title: 'Your code sends the history.',
        body: "Logbird doesn't rebuild history from your database. Import past events by sending them with their original `occurredAt`, up to 3650 days back; an older value is stored at receive time with a warning, and project retention still applies.",
      },
      { title: 'Retention means deletion.', body: 'Expired events are deleted for good.' },
      { title: 'We audit ourselves.', body: "Logbird records its own management actions in your workspace's activity stream." },
    ],
  },
  name: {
    eyebrow: 'The name',
    title: 'Logbird',
    lead: 'The bird that carries every event home. We chose a short name made of two words you already know, so anyone who hears it once can spell it.',
  },
  build: {
    eyebrow: 'Building in public',
    title: 'Follow the build.',
    lead: 'We write up what we ship as we go. Every post uses real captures from the product.',
    changelogAction: 'Read the changelog',
    contactAction: 'Contact us',
  },
} as const;
