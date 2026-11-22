import { roadmap } from './roadmap';
import { sharedContent } from './shared';
import { byCloud, byRepo, type Cta, type Marked, SITE, type SiteState } from './site';

/**
 * Pricing, as one data file (routes/pricing.tsx, and the plan cards on /cloud). Brief: marketing/copy/pricing.md.
 *
 * It states only what is public and decided: self-hosting is free under MIT with every feature in the repository;
 * Logbird Cloud's pricing isn't set; support and enterprise is "talk to us". Anything else about Logbird Cloud's pricing
 * is the owner's decision and is not in this repository until approved (maintainer ruling, 2026-11-22). When it is, it
 * arrives here as data in one change: plans with their `figures`, the `dimensions` they differ on, and PRICING_APPROVED.
 * Every figure is a slot that renders nothing while empty, and pricing.test.ts fails if a price, a named plan or a
 * checkout link appears while PRICING_APPROVED is false.
 */

/** The owner has approved Logbird Cloud's pricing. Until then no figure renders and no plan links to checkout. */
export const PRICING_APPROVED = false;

/** Something plans can differ on (for example a price or a limit). None are public yet. */
export interface Dimension {
  id: string;
  label: string;
}

/** A value for one dimension: written exactly as it will be shown, with where it comes from. */
export interface Figure {
  value: string;
  source: string;
}

export interface Plan {
  id: string;
  name: string;
  /** The one-line state shown large on the card, never a price while PRICING_APPROVED is false. */
  status: string;
  body: string;
  icon: 'server' | 'cloud' | 'support';
  cta: Cta & { primary?: boolean; href?: string };
  /** Per-dimension figures, keyed by Dimension.id. Empty until pricing is approved. */
  figures: Record<string, Figure>;
}

/** What you get, each with the source that makes it true today. */
export interface Feature {
  title: string;
  body: Marked;
  source: string;
}

/** What plans differ on, once approved. Empty until then; the owner-approved values arrive here as data. */
const DIMENSIONS: Dimension[] = [];

/** `approved` defaults to PRICING_APPROVED; tests pass both values. */
export function pricingContent(site: SiteState, approved = PRICING_APPROVED) {
  const shared = sharedContent(site);
  // Figures and dimensions render only once pricing is approved, whatever the data holds.
  const dimensions: Dimension[] = approved ? DIMENSIONS : [];
  /** The Cloud plan's button: checkout only once pricing is approved and a checkout URL is configured. */
  const cloudCta: Plan['cta'] =
    approved && site.checkoutUrl
      ? { label: 'Start with Logbird Cloud', to: '/contact', href: site.checkoutUrl, primary: true }
      : { label: shared.accessCta, to: '/contact', primary: true };
  const allPlans: Plan[] = [
    {
      id: 'self-host',
      name: 'Self-host',
      status: 'Free, MIT',
      body: byRepo(site, {
        public: 'Free and MIT-licensed. Every feature in the repository. You run it.',
        private: "Free and MIT-licensed once the source opens, with every feature in the repository. You'll run it.",
      }),
      icon: 'server',
      cta: { ...shared.selfHostCta },
      figures: {},
    },
    {
      id: 'cloud',
      name: 'Cloud',
      status: byCloud(site, { open: 'Early access', closed: 'Waitlist' }),
      body: byCloud(site, {
        open: 'We run it for you. Open to invited teams for now.',
        closed: "We'll run it for you. Waitlist only for now.",
      }),
      icon: 'cloud',
      cta: cloudCta,
      figures: {},
    },
    {
      id: 'support',
      name: 'Support and enterprise',
      status: 'Talk to us',
      body: "For teams that want help running Logbird, or terms we haven't covered here.",
      icon: 'support',
      cta: { label: 'Contact us', to: '/contact' },
      figures: {},
    },
  ];
  const plans = approved ? allPlans : allPlans.map((plan) => ({ ...plan, figures: {} }));
  /** Until approval: "not set yet". After it: neutral wording that points at the plans; the plans carry the facts. */
  const unset = !approved;

  const features: Feature[] = [
    {
      title: 'Ingest over HTTP or the TypeScript SDK',
      body: 'One event per action; only `action` is required.',
      source: 'docs/SPEC.md §1.1; packages/sdk/README.md',
    },
    {
      title: 'Search',
      body: 'The query language, or a guarded SQL `WHERE` expression.',
      source: 'docs/SPEC.md §5.1; docs/query-language.md',
    },
    {
      title: 'Entity pages',
      body: 'Actors, tenants, executors and records get their own pages and timelines.',
      source: 'docs/concepts.md',
    },
    {
      title: 'Operation trees',
      body: 'The events that share an operation id, from the request to the jobs it spawned.',
      source: 'docs/concepts.md § Operations',
    },
    {
      title: 'Exports',
      body: 'CSV, JSON Lines, and an evidence export with every event’s original payload.',
      source: 'docs/exports.md § Which format?',
    },
    {
      title: 'Retention you choose',
      body: 'Per project, from 7 days to 10 years. Expired events are permanently deleted.',
      source: 'packages/contracts/src/api.ts RETENTION_OPTIONS; docs/SPEC.md §4',
    },
    {
      title: 'Workspace activity',
      body: "Logbird's own record of what your team does: projects, retention, keys, members, exports and sign-ins.",
      source: 'docs/workspace-audit.md § Activity action catalogue',
    },
    {
      title: 'Teams and roles',
      body: 'Invitations, and owner, admin and member roles.',
      source: 'docs/SPEC.md §7.1',
    },
    {
      title: 'Integrations',
      body: 'Hono, TanStack Start, Vue and Nuxt.',
      source: 'docs/integrations.md',
    },
    ...(site.scopedReadLive
      ? [
          {
            title: 'Customer-facing history',
            body: 'Tenant-scoped read keys, and short-lived viewer tokens for the browser.',
            source: 'docs/scoped-read-access.md',
          },
        ]
      : []),
  ];

  return {
    meta: {
      title: 'Pricing',
      description: `${byRepo(site, {
        public: 'Self-hosting Logbird is free under the MIT licence, with every feature.',
        private: 'Self-hosting Logbird will be free under the MIT licence once the source opens.',
      })} ${unset ? "Logbird Cloud's pricing isn't set yet." : "Logbird Cloud's prices are on this page."}`,
    },
    hero: {
      eyebrow: 'Pricing',
      title: unset
        ? byRepo(site, {
            public: 'Self-hosting is free. Cloud pricing isn’t set yet.',
            private: 'Self-hosting will be free. Cloud pricing isn’t set yet.',
          })
        : 'Pricing',
      lead: `${byRepo(site, {
        public: 'Logbird is MIT-licensed, and every feature in the repository is yours to run.',
        private: 'Logbird is MIT-licensed, and every feature in the repository will be yours to run once the source opens.',
      })} ${byCloud(site, {
        open: 'Logbird Cloud runs the same codebase for you, in early access;',
        closed: 'Logbird Cloud will run the same codebase for you;',
      })} ${unset ? 'its pricing will be published before billing starts.' : 'its prices are below.'}`,
    },
    /** The pricing section and status row on /cloud, from the same source. */
    cloud: {
      eyebrow: 'Pricing',
      title: unset ? "Pricing isn't set yet." : 'Pricing',
      lead: unset
        ? "Self-hosting is free under the MIT licence. Logbird Cloud's pricing will be published before billing starts."
        : "Self-hosting is free under the MIT licence. Logbird Cloud's prices are on the pricing page.",
      note: 'Nothing on this page is an offer.',
      more: { label: 'See pricing', to: '/pricing' } satisfies Cta,
      status: {
        label: 'Pricing',
        value: unset ? "Isn't set yet" : 'Published',
        note: unset ? 'Published before billing starts' : 'See the pricing page',
      },
    },
    plans,
    dimensions,
    included: {
      eyebrow: 'Self-hosted',
      title: 'What you get when you self-host.',
      lead: 'Every feature below is in the repository today, under the MIT licence.',
      features,
    },
    roadmap,
    faq: {
      eyebrow: 'Questions',
      title: 'Pricing questions.',
      items: [
        {
          q: 'Does self-hosting include every feature?',
          a: byRepo(site, {
            public: 'Yes. Everything in the repository is MIT-licensed, and self-hosting gets all of it.',
            private: 'Yes. Once the source opens, everything in the repository is MIT-licensed, and self-hosting gets all of it.',
          }),
        },
        {
          q: 'How much will Logbird Cloud cost?',
          a: unset ? "Pricing isn't set yet. We'll publish it before billing starts." : 'See the plans at the top of this page.',
        },
        {
          q: 'How do I get early access?',
          a: byCloud(site, {
            open: 'Request access through the contact form. Sign-ups are limited to invited teams for now.',
            closed: "Join the waitlist through the contact form. We'll write when Logbird Cloud opens.",
          }),
        },
      ],
    },
  };
}

export type PricingContent = ReturnType<typeof pricingContent>;
export const pricing: PricingContent = pricingContent(SITE);
