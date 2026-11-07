export interface SitePage {
  path: string;
  title: string;
  description: string;
  section: 'product' | 'developers' | 'company' | 'legal' | 'compare' | 'resources';
  priority: number;
  changefreq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  ogSlug: string;
  inNav?: boolean;
  inFooter?: boolean;
  /** Shorter label for the footer, when the title is long. */
  footerTitle?: string;
  /**
   * Designed and approved for publishing. Pages that aren't ready render a placeholder, are `noindex`, and are left out
   * of the nav, footer, sitemap and llms.txt. Each page PR flips its own flag.
   */
  ready: boolean;
}
export const siteMap: SitePage[] = [
  {
    path: '/',
    title: 'Home',
    description: 'Open-source audit logs you can self-host.',
    section: 'product',
    priority: 1,
    changefreq: 'daily',
    ready: true,
    ogSlug: 'home',
    inNav: false,
    inFooter: false,
  },
  {
    path: '/product',
    title: 'Product',
    description: 'Product page content is being prepared.',
    section: 'product',
    priority: 0.9,
    changefreq: 'weekly',
    ready: false,
    ogSlug: 'product',
    inNav: true,
    inFooter: true,
    footerTitle: 'Product tour',
  },
  {
    path: '/developers',
    title: 'Developers',
    description: 'Developers page content is being prepared.',
    section: 'developers',
    priority: 0.9,
    changefreq: 'weekly',
    ready: false,
    ogSlug: 'developers',
    inNav: true,
    inFooter: true,
    footerTitle: 'Developer guide',
  },
  {
    path: '/self-hosting',
    title: 'Self-host',
    description: 'Self-host page content is being prepared.',
    section: 'developers',
    priority: 0.9,
    changefreq: 'weekly',
    ready: false,
    ogSlug: 'self-hosting',
    inNav: true,
    inFooter: true,
  },
  {
    path: '/cloud',
    title: 'Cloud',
    description: "Logbird Cloud will run the same open-source codebase for you. It isn't open yet. Join the waitlist. Pricing isn't set yet.",
    section: 'product',
    priority: 0.9,
    changefreq: 'weekly',
    ready: true,
    ogSlug: 'cloud',
    inNav: true,
    inFooter: true,
  },
  {
    path: '/open-source',
    title: 'Open source',
    description: 'Logbird is MIT-licensed. API, console, worker, SDK and integrations live in one repository, which opens publicly soon.',
    section: 'developers',
    priority: 0.8,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'open-source',
    inNav: true,
    inFooter: true,
  },
  {
    path: '/security',
    title: 'Security',
    description: "How Logbird isolates projects, stores keys, guards SQL, deletes expired data and audits itself, and what we don't claim yet.",
    section: 'company',
    priority: 0.7,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'security',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/compare',
    title: 'Compare',
    description:
      'Fair, sourced comparisons of Logbird with Retraced, WorkOS Audit Logs, Pangea Secure Audit Log and Bemi, including when to choose them.',
    section: 'compare',
    priority: 0.8,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'compare',
    inNav: true,
    inFooter: true,
    footerTitle: 'All comparisons',
  },
  {
    path: '/compare/retraced',
    title: 'Retraced',
    description: 'Retraced is an Apache-2.0 audit log service with an embeddable React viewer. How it compares with Logbird, sourced and dated.',
    section: 'compare',
    priority: 0.7,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'compare-retraced',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/compare/workos-audit-logs',
    title: 'WorkOS Audit Logs',
    description:
      'WorkOS Audit Logs is a hosted audit log API with an Admin Portal viewer and SIEM log streams. How it compares with Logbird, sourced.',
    section: 'compare',
    priority: 0.7,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'compare-workos-audit-logs',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/compare/pangea',
    title: 'Pangea',
    description:
      'Pangea Secure Audit Log is a hosted, tamperproof audit log with Merkle-tree proofs. How it compares with Logbird, sourced and dated.',
    section: 'compare',
    priority: 0.7,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'compare-pangea',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/compare/bemi',
    title: 'Bemi',
    description:
      'Bemi captures every Postgres row change automatically. Logbird records the actions your app reports. Different tools, sometimes used together.',
    section: 'compare',
    priority: 0.7,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'compare-bemi',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/changelog',
    title: 'Changelog',
    description: 'Changelog page content is being prepared.',
    section: 'resources',
    priority: 0.6,
    changefreq: 'weekly',
    ready: false,
    ogSlug: 'changelog',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/blog',
    title: 'Blog',
    description: 'Blog page content is being prepared.',
    section: 'resources',
    priority: 0.6,
    changefreq: 'weekly',
    ready: false,
    ogSlug: 'blog',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/blog/$slug',
    title: 'Draft article',
    description: 'Draft article page content is being prepared.',
    section: 'resources',
    priority: 0.3,
    changefreq: 'monthly',
    ready: false,
    ogSlug: 'blog-draft',
    inNav: false,
    inFooter: false,
  },
  {
    path: '/about',
    title: 'About',
    description: 'About page content is being prepared.',
    section: 'company',
    priority: 0.6,
    changefreq: 'monthly',
    ready: false,
    ogSlug: 'about',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/contact',
    title: 'Contact',
    description: 'Join the Logbird Cloud waitlist or send us a question. We store your email only to contact you about Logbird. No trackers.',
    section: 'company',
    priority: 0.7,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'contact',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/legal/privacy',
    title: 'Privacy',
    description: 'Privacy page content is being prepared.',
    section: 'legal',
    priority: 0.3,
    changefreq: 'yearly',
    ready: false,
    ogSlug: 'privacy',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/legal/terms',
    title: 'Terms',
    description: 'Terms page content is being prepared.',
    section: 'legal',
    priority: 0.3,
    changefreq: 'yearly',
    ready: false,
    ogSlug: 'terms',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/404',
    title: 'Page not found',
    description: 'The requested page could not be found.',
    section: 'resources',
    priority: 0,
    changefreq: 'yearly',
    ready: false,
    ogSlug: '404',
  },
];
export const staticPages = siteMap.filter((page) => !page.path.includes('$') && page.path !== '/404');
/** Pages that are linked from the nav/footer and listed in the sitemap and llms.txt. */
export const publishedPages = staticPages.filter((page) => page.ready);
/** The draft route is exercised in static output but deliberately never indexed. */
export const prerenderPaths = [...staticPages.map((page) => page.path), '/blog/draft'];
export function getPage(path: string): SitePage {
  const page = siteMap.find((entry) => entry.path === path);
  if (!page) {
    throw new Error(`Missing site manifest entry: ${path}`);
  }
  return page;
}
