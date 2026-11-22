import { afterEach, describe, expect, it, vi } from 'vitest';
import { quietHrefWarnings, renderPages } from '../test/render-pages';
import { PRICING_APPROVED, pricing, pricingContent } from './pricing';
import { SITE, type SiteState } from './site';

/**
 * Maintainer ruling (2026-11-22): until the owner approves pricing, the site states only what is public: self-hosting is
 * free under MIT, Logbird Cloud's pricing isn't set, support is "talk to us". Rather than search for forbidden words,
 * this test allows exactly the approved card texts: anything else on a plan card (a name, a price, an allowance) fails.
 * The unapproved-state checks skip once PRICING_APPROVED is true, so approval stays a data-only change.
 */
const SELF_HOST = {
  public: 'Self-host Free, MIT Free and MIT-licensed. Every feature in the repository. You run it. Self-host it',
  private:
    "Self-host Free, MIT Free and MIT-licensed once the source opens, with every feature in the repository. You'll run it. Self-host when the source opens",
};
const CLOUD = {
  closed: "Cloud Waitlist We'll run it for you. Free during early access; waitlist only for now. Join the waitlist",
  open: 'Cloud Early access We run it for you. Free during early access, which is open to invited teams for now. Request access',
};
const SUPPORT = "Support and enterprise Talk to us For teams that want help running Logbird, or terms we haven't covered here. Contact us";

const GITHUB = { WEB_GITHUB_URL: 'https://github.com/example-org/logbird' };
const CHECKOUT = { WEB_CHECKOUT_URL: 'https://checkout.example.test/pay?token=abc/' };
const STATES = [
  { env: { ...GITHUB, ...CHECKOUT, WEB_GITHUB_PUBLIC: 'true' }, cards: [SELF_HOST.public, CLOUD.closed, SUPPORT] },
  {
    env: { ...GITHUB, ...CHECKOUT, WEB_GITHUB_PUBLIC: 'true', WEB_APP_URL: 'https://app.example.test' },
    cards: [SELF_HOST.public, CLOUD.open, SUPPORT],
  },
  { env: { ...GITHUB, ...CHECKOUT }, cards: [SELF_HOST.private, CLOUD.closed, SUPPORT] },
  { env: { ...GITHUB, ...CHECKOUT, WEB_APP_URL: 'https://app.example.test' }, cards: [SELF_HOST.private, CLOUD.open, SUPPORT] },
];

const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();

/** The plan cards' texts, in order: each card is an `li.panel` in the list PlanCards renders. */
function cardTexts(html: string): string[] {
  return [...html.matchAll(/<li class="panel[^"]*">([\s\S]*?)<\/li>/g)].map(([, inner]) => plain(inner ?? ''));
}

/** Every JSON-LD object on the page, parsed, so the check doesn't depend on property order. */
function structuredData(html: string): unknown[] {
  const found: unknown[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      found.push(value);
      Object.values(value).forEach(walk);
    }
  };
  for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) walk(JSON.parse(json ?? 'null'));
  return found;
}

const state = (overrides: Partial<SiteState> = {}): SiteState => ({
  repoPublic: true,
  cloudOpen: false,
  scopedReadLive: false,
  checkoutUrl: 'https://checkout.example.test/pay?token=abc/',
  ...overrides,
});

describe('pricing', () => {
  // quietHrefWarnings spies on console.error; restore it so a second call doesn't wrap the first spy.
  afterEach(() => vi.restoreAllMocks());

  it('lists customer-facing history only once scoped read access is live, and the page follows SITE', async () => {
    const titles = (site: SiteState) => pricingContent(site, false).included.features.map((feature) => feature.title);
    expect(titles(state({ scopedReadLive: true }))).toContain('Customer-facing history');
    expect(titles(state({ scopedReadLive: false }))).not.toContain('Customer-facing history');
    quietHrefWarnings();
    const [page] = await renderPages(['/pricing']);
    expect(plain(page?.html ?? '').includes('Customer-facing history'), 'row shown').toBe(SITE.scopedReadLive);
  }, 60_000);

  it('links a plan to checkout only once pricing is approved and a checkout URL is configured, keeping the URL exact', () => {
    const cloud = (approved: boolean, site: SiteState) => pricingContent(site, approved).plans.find((plan) => plan.id === 'cloud');
    expect(cloud(false, state())?.cta.href).toBeUndefined();
    expect(cloud(true, state({ checkoutUrl: undefined }))?.cta.href).toBeUndefined();
    expect(cloud(true, state())?.cta.href).toBe('https://checkout.example.test/pay?token=abc/');
  });

  it('renders figures and dimensions only once approved, whatever the data holds', () => {
    expect(pricingContent(state(), false).dimensions).toEqual([]);
    for (const plan of pricingContent(state(), false).plans) expect(plan.figures, plan.id).toEqual({});
  });

  describe.skipIf(PRICING_APPROVED)('while pricing is not approved', () => {
    it('holds only the three public plans', () => {
      expect(pricing.plans.map((plan) => plan.id)).toEqual(['self-host', 'cloud', 'support']);
    });

    it('renders exactly the approved plan cards, and no figure, checkout link or Cloud offer, in every repository and Cloud state', async () => {
      quietHrefWarnings();
      for (const { env, cards } of STATES) {
        for (const { path, html } of await renderPages(['/pricing', '/cloud'], env)) {
          const where = `${path} (${JSON.stringify(env)})`;
          expect(cardTexts(html), where).toEqual(cards);
          expect(html, where).not.toContain('checkout.example.test');
          const offers = structuredData(html).filter((node) => (node as { '@type'?: unknown })['@type'] === 'Offer');
          expect(offers, `${where}: no structured-data offer on the pricing pages`).toEqual([]);
          expect(plain(html), where).toMatch(/[Pp]ricing isn[’']t set yet/);
          expect(plain(html), where).toContain('free during early access');
        }
      }
    }, 120_000);
  });
});
