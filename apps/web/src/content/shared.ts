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
    /** The footer's line under the brand line. "Open-source" only while the source is public. */
    footerTagline: byRepo(site, {
      public: 'The open-source audit log for your product.',
      private: 'The audit log for your product. The source opens soon.',
    }),
    /** The accessible name of a capture that opens full size (components/screenshot.tsx). */
    openFullSize: 'Open the image full size',
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
        private: byCloud(site, {
          open: "The source opens soon. Request access to Logbird Cloud, where sign-ups are limited to invited teams for now, and we'll tell you when you can self-host.",
          closed: 'The source opens soon. Join the waitlist to hear when you can self-host Logbird, and when Logbird Cloud opens.',
        }),
      }),
    },
  };
}

export const shared = sharedContent(SITE);
