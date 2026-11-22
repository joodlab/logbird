import { byCloud, byRepo, type Cta, SITE, type SiteState } from './site';

/**
 * Words that several pages share: the primary and self-host calls to action, the Cloud status line and the closing
 * band. Brief: marketing/copy/README.md § Cloud CTA rule, and marketing/copy/home.md.
 */
export function sharedContent(site: SiteState) {
  return {
    /** The primary call to action, leading to the form on /contact. */
    accessCta: byCloud(site, { open: 'Request access', closed: 'Join the waitlist' }),
    /** One line on where the Cloud stands, for small print under hero actions. */
    cloudStatusLine: byCloud(site, {
      open: 'Logbird Cloud is in early access: sign-ups are limited to invited teams for now.',
      closed: 'Logbird Cloud is not open yet.',
    }),
    /**
     * The secondary call to action. Until the repository is public nobody can self-host, so it says so and leads to the
     * waitlist with "self-host" preselected instead of promising a quickstart.
     */
    selfHostCta: byRepo<Cta>(site, {
      public: { label: 'Self-host it', to: '/self-hosting' },
      private: { label: 'Self-host when the source opens', to: '/contact', search: { interest: 'self-host' } },
    }),
    /** The header's link to the repository, shown only while it is public. */
    githubNav: site.githubUrl ? { label: 'GitHub', href: site.githubUrl } : undefined,
    /** The closing call to action at the bottom of most pages. */
    ctaBand: {
      title: 'Start with one event.',
      body: byRepo(site, {
        public: byCloud(site, {
          open: 'Self-host Logbird today, or request access to Logbird Cloud, where sign-ups are limited to invited teams for now.',
          closed: 'Self-host Logbird today, or join the waitlist for Logbird Cloud.',
        }),
        private: 'The source opens soon. Join the waitlist to hear when you can self-host Logbird, and when Logbird Cloud opens.',
      }),
    },
  };
}

export const shared = sharedContent(SITE);
