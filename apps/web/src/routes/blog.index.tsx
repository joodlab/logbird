import { createFileRoute, Link } from '@tanstack/react-router';
import { ButtonLink } from '../components/marketing/button-link';
import { PageHero, Section } from '../components/marketing/section';
import { blog } from '../content/blog';
import { newestFirst, posts, publicationDate } from '../lib/publications';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/blog/')({ head: () => pageHead('/blog'), component: BlogIndex });

// Words: content/blog.ts. Posts come from publications.ts, added only once the owner publishes them. This file is layout
// only (content-modules.test.ts).
function BlogIndex() {
  const { hero } = blog;
  return (
    <>
      <PageHero
        actions={
          <ButtonLink to="/changelog" variant="outline">
            {hero.changelog}
          </ButtonLink>
        }
        eyebrow={hero.eyebrow}
        lead={hero.lead}
        title={hero.title}
      />
      <Section labelledBy="posts-title">
        <h2 className="sr-only" id="posts-title">
          {blog.postsTitle}
        </h2>
        {posts.length ? (
          <ol className="flex flex-col divide-y border-y">
            {newestFirst(posts).map((post) => (
              <li className="flex flex-col gap-2 py-8" key={post.slug}>
                <time className="font-mono text-muted-foreground text-sm" dateTime={post.published}>
                  {publicationDate(post.published)}
                </time>
                <h3 className="h3">
                  <Link className="hover:underline" params={{ slug: post.slug }} to="/blog/$slug">
                    {post.title}
                  </Link>
                </h3>
                <p className="max-w-3xl text-muted-foreground leading-relaxed">{post.description}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="panel p-6 text-muted-foreground">{blog.empty}</p>
        )}
      </Section>
    </>
  );
}
