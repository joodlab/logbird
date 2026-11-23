import { getPage } from '../lib/site-map';
import { pricing } from './pricing';
import { byCloud, byRepo, SITE } from './site';

/**
 * Words of /cloud. Brief: marketing/copy/cloud.md. No prices, limits, SLAs or dates on this page; the pricing section
 * and the cost answer come from content/pricing.ts. Each FAQ answer has a plain `a` (also the FAQPage JSON-LD) and,
 * where it needs code or a link, a `rich` body (`code` marks) or `privacyLink` parts.
 */
const privacyReady = getPage('/legal/privacy').ready;
const runs = byCloud(SITE, { open: 'runs', closed: 'will run' });

export interface CloudFaq {
  q: string;
  a: string;
  rich?: string;
  /** "… See the [privacy policy]." with the link to /legal/privacy. */
  privacyLink?: { before: string; label: string; after: string };
}

const faq: CloudFaq[] = [
  byCloud<CloudFaq>(SITE, {
    open: {
      q: 'When can everyone sign up?',
      a: "We haven't set a date. Logbird Cloud is in early access: sign-ups are limited to invited teams while we onboard them. Request access and we'll be in touch.",
    },
    closed: { q: 'When does Logbird Cloud open?', a: "We haven't set a date. People on the waitlist hear first." },
  }),
  {
    q: 'Where will my data be stored?',
    a: byCloud(SITE, {
      open: byRepo(SITE, {
        public:
          "We'll publish the hosting region with the Cloud's launch terms. Ask us before you send production data. If your data must stay in a particular place, self-host Logbird.",
        private:
          "We'll publish the hosting region with the Cloud's launch terms. Ask us before you send production data. If your data must stay in a particular place, self-hosting is an option once the source opens.",
      }),
      closed: byRepo(SITE, {
        public:
          "Not decided yet. We'll publish the hosting region before the cloud opens. If your data must stay in a particular place today, self-host Logbird.",
        private:
          "Not decided yet. We'll publish the hosting region before the cloud opens. If your data must stay in a particular place, self-hosting is an option once the source opens.",
      }),
    }),
  },
  {
    q: 'Is the cloud a different product?',
    a: `No. It ${runs} the same codebase as the self-hosted version. One difference is already decided: Logbird Cloud won't offer a free-form SQL console. The guarded SQL WHERE mode in the explorer is in both.`,
    rich: `No. It ${runs} the same codebase as the self-hosted version. One difference is already decided: Logbird Cloud won't offer a free-form SQL console. The guarded SQL \`WHERE\` mode in the explorer is in both.`,
  },
  {
    q: 'Can I move between self-host and cloud?',
    a: byCloud(SITE, {
      open: "Not with a tool or a guide today. Both run the same codebase, but there's no migration tool and no documented migration path yet.",
      closed:
        "Not with a tool or a guide. Logbird Cloud will run the same codebase, but there's no migration tool and no documented migration path yet.",
    }),
  },
  // From content/pricing.ts, so the answer changes with the pricing data.
  { q: 'How much will it cost?', a: pricing.cloud.lead },
  {
    q: 'Will there be an SLA?',
    a: byCloud(SITE, {
      open: 'Not during early access. There are no published service levels or limits yet.',
      closed: 'There are no published service levels or limits yet.',
    }),
  },
  {
    q: byCloud(SITE, { open: 'What do you do with the email I give you?', closed: 'What do you do with my waitlist email?' }),
    // The privacy notice is referenced only once /legal/privacy is ready (site-map), here and in the FAQ JSON-LD.
    a: privacyReady
      ? 'We store it to contact you about Logbird. No trackers. See the privacy policy.'
      : 'We store it to contact you about Logbird. No trackers.',
    privacyLink: privacyReady
      ? { before: 'We store it to contact you about Logbird. No trackers. See the ', label: 'privacy policy', after: '.' }
      : undefined,
  },
];

export const cloud = {
  hero: {
    eyebrow: 'Logbird Cloud',
    title: 'The same Logbird, run by us.',
    lead: byCloud(SITE, {
      open: `Logbird Cloud runs the same ${byRepo(SITE, { public: 'open-source codebase you can', private: "codebase you'll be able to" })} self-host. We run the servers, the upgrades and the backups. It's in early access: sign-ups are limited to invited teams for now. Request access, or sign in if you've been invited.`,
      closed: `Logbird Cloud will run the same ${byRepo(SITE, { public: 'open-source codebase you can', private: "codebase you'll be able to" })} self-host. We'll run the servers, the upgrades and the backups. It isn't open yet. Join the waitlist and we'll email you when it is.`,
    }),
    signIn: 'Sign in',
  },
  status: {
    title: 'Where things stand',
    rows: [
      byCloud(SITE, {
        open: { label: 'Logbird Cloud', value: 'Early access', note: 'Invited teams' },
        closed: { label: 'Logbird Cloud', value: 'Not open yet', note: 'Waitlist' },
      }),
      pricing.cloud.status,
      byRepo(SITE, {
        public: { label: 'Self-host', value: 'Available today', note: 'Free, MIT' },
        private: { label: 'Self-host', value: 'When the source opens', note: 'Free, MIT' },
      }),
    ],
  },
  faq: {
    eyebrow: 'Questions',
    title: 'Cloud questions, answered as far as we can today.',
    items: faq,
  },
  ctaTitle: byCloud(SITE, { open: 'Want early access?', closed: 'Be first to hear when it opens.' }),
} as const;
