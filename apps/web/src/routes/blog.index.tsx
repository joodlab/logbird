import { createFileRoute, Link } from '@tanstack/react-router';
import { ButtonLink } from '../components/marketing/button-link';
import { PageHero, Section } from '../components/marketing/section';
import { newestFirst, posts, publicationDate } from '../lib/publications';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/blog/')({ head: () => pageHead('/blog'), component: BlogIndex });

// Copy: marketing/copy/blog.md. Posts come from publications.ts, added only once the owner publishes them.
function BlogIndex() {
  return (
    <>
      <PageHero
        actions={
          <ButtonLink to="/changelog" variant="outline">
            Changelog and build log
          </ButtonLink>
        }
        eyebrow="Blog"
        lead="Longer posts on how Logbird works and why: the decisions, the guarantees, and the limits. For day-by-day progress, see the changelog."
        title="Notes from building Logbird."
      />
      <Section labelledBy="posts-title">
        <h2 className="sr-only" id="posts-title">
          Posts
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
          <p className="panel p-6 text-muted-foreground">No posts yet. The first one is on its way.</p>
        )}
      </Section>
    </>
  );
}
