import { createFileRoute, redirect } from '@tanstack/react-router';

/** Old Quickstart anchors → their new home on the Setup page. */
const HASHES: Record<string, string> = {
  install: 'first-event',
  send: 'first-event',
  envelope: 'envelope',
  semantics: 'semantics',
  query: 'query',
  keys: 'shortcuts',
  read: 'read-key',
};

/** The Quickstart page became Setup; keep old links (and bookmarks) working. */
export const Route = createFileRoute('/_authed/_workspace/p/$projectId/docs')({
  beforeLoad: ({ params, location }) => {
    throw redirect({
      to: '/p/$projectId/setup',
      params,
      hash: location.hash ? (HASHES[location.hash] ?? location.hash) : undefined,
      replace: true,
    });
  },
});
