/**
 * The frame around one blog post (components/marketing/blog-article.tsx): its eyebrow and the byline's update note. The
 * post's own words are its entry in lib/publications.ts. No imports, so the article stays router-free.
 */
export const blogPost = {
  eyebrow: 'Blog',
  /** Before the modified date, after the publication date: "· updated <date>". */
  updated: '· updated ',
} as const;
