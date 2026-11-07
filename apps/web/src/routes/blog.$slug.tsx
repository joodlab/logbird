import { createFileRoute, notFound } from '@tanstack/react-router';
import { BlogArticle } from '../components/marketing/blog-article';
import { CtaBand } from '../components/marketing/cta-band';
import { findPost } from '../lib/publications';
import { postHead } from '../lib/seo';

// Only published posts exist (publications.ts); any other slug is the site's 404.
export const Route = createFileRoute('/blog/$slug')({
  loader: ({ params }) => {
    const post = findPost(params.slug);
    if (!post) {
      throw notFound();
    }
    return post;
  },
  // An unknown slug renders NotFound, which sets its own title and noindex.
  head: ({ loaderData }) => (loaderData ? postHead(loaderData) : {}),
  component: BlogPostPage,
});

function BlogPostPage() {
  const post = Route.useLoaderData();
  return (
    <>
      <BlogArticle post={post} />
      <CtaBand />
    </>
  );
}
