/**
 * The single seam between the console and the network.
 *
 * Real mode (default): the browser `fetch`, same-origin, cookies included — `/api` and `/v1`
 * are proxied to the Hono server, so the better-auth session cookie is first-party.
 *
 * Fixture mode (dev only, `VITE_FIXTURES=1` / `pnpm dev:fixtures`): an in-memory server from
 * `src/dev/` answers the same URLs with contract-shaped data. Components, query factories and
 * the auth client never know which one they talk to. In production builds the fixture branch is
 * statically false and the `src/dev` chunk is never emitted.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const FIXTURES = import.meta.env.DEV && import.meta.env.VITE_FIXTURES === '1';

let transport: Promise<FetchLike> | null = null;

function loadTransport(): Promise<FetchLike> {
  if (FIXTURES) {
    return import('@/dev/fixture-server').then((m) => m.fixtureFetch);
  }
  return Promise.resolve((input, init) => fetch(input, { credentials: 'include', ...init }));
}

export function getTransport(): Promise<FetchLike> {
  transport ??= loadTransport();
  return transport;
}

/** A `fetch`-compatible function bound to the active transport (for the better-auth client). */
export const transportFetch: FetchLike = async (input, init) => {
  const impl = await getTransport();
  return impl(input, init);
};
