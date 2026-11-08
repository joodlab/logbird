import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '../components/not-found';

/**
 * Prerendered as 404.html, which Cloudflare and the Node server send for every unknown path. The browser then
 * hydrates it at that unknown URL, where the router renders the root's notFoundComponent, so this route must render
 * exactly the same document: no head of its own (NotFound sets its title and noindex itself). A test compares the two.
 */
export const Route = createFileRoute('/404')({
  component: NotFound,
});
