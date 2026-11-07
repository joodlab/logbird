import { type Post, publicationDate } from '../../lib/publications';
import { Rich } from './rich';

/** One post: title, byline and paragraphs. Router-free, so it renders the same in tests and in the route. */
export function BlogArticle({ post }: { post: Post }) {
  return (
    <article className="container-site flex max-w-3xl flex-col gap-6 py-16 md:py-24">
      <header className="flex flex-col gap-4 border-b pb-8">
        <p className="eyebrow">Blog</p>
        <h1 className="h1">{post.title}</h1>
        <p className="lead">{post.description}</p>
        <p className="text-muted-foreground text-sm">
          {post.author} · <time dateTime={post.published}>{publicationDate(post.published)}</time>
          {post.modified ? (
            <>
              {' '}
              · updated <time dateTime={post.modified}>{publicationDate(post.modified)}</time>
            </>
          ) : null}
        </p>
      </header>
      <div className="body-copy flex flex-col gap-5 text-lg leading-relaxed">
        {post.body.map((paragraph, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional and may repeat; the list never reorders
          <p key={index}>
            <Rich text={paragraph} />
          </p>
        ))}
      </div>
    </article>
  );
}
