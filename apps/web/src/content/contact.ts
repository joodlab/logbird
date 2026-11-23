import { byCloud, SITE } from './site';

/** Words of /contact. Brief: marketing/copy/contact.md. The form's own words are in components/waitlist-form.tsx. */
export const contact = {
  hero: {
    eyebrow: 'Contact',
    title: byCloud(SITE, { open: 'Request access, or ask us anything.', closed: 'Join the waitlist, or ask us anything.' }),
    lead: byCloud(SITE, {
      open: 'Logbird Cloud is in early access, with sign-ups limited to invited teams. Leave your email to request access. If you have a question about self-hosting, support or something else, choose it below.',
      closed:
        "Logbird Cloud isn't open yet. Leave your email and we'll write when it is. If you have a question about self-hosting, support or something else, choose it below.",
    }),
  },
  elsewhere: {
    eyebrow: 'Elsewhere',
    title: 'Other ways to reach us.',
    security: 'Security issues',
    source: {
      title: 'Source and issues',
      /** While the repository is public: links to it and to its issues. */
      repo: SITE.githubUrl
        ? {
            href: SITE.githubUrl,
            label: 'On GitHub',
            middle: ': report bugs and ask questions in ',
            issuesHref: `${SITE.githubUrl}/issues`,
            issuesLabel: 'issues',
            end: '.',
          }
        : undefined,
      soon: 'Source on GitHub — coming soon.',
    },
    signIn: SITE.signInUrl ? { title: 'Already invited?', href: SITE.signInUrl, label: 'Sign in to Logbird Cloud', end: '.' } : undefined,
  },
} as const;
