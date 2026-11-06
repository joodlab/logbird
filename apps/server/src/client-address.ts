/**
 * Resolve the client address from `X-Forwarded-For` when `trustedHops` proxies sit in front of the API.
 *
 * Each trusted proxy appends the address it received the connection from, so the entry `trustedHops` from the
 * right was written by the outermost trusted proxy; anything further left is client-controlled. The self-hosted
 * console is always one such hop (it appends the browser or upstream proxy address), so Compose installs use 1
 * when clients reach the console directly and 2 behind one reverse proxy (Caddy, Coolify/Traefik, Nginx).
 * With fewer entries than hops every entry came from a trusted proxy, so the leftmost one is used. Without
 * trusted hops, or without the header, the socket peer is the client.
 */
export function pickClientAddress(forwardedFor: string | undefined, peer: string | undefined, trustedHops: number): string | undefined {
  if (trustedHops < 1) return peer;
  const entries = (forwardedFor ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return peer;
  return entries.at(-Math.min(trustedHops, entries.length));
}

/** `TRUST_PROXY`: false/empty → 0, true → 1, or an explicit hop count. */
export function parseTrustedHops(value: string | undefined): number {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0') return 0;
  if (v === 'true') return 1;
  if (/^\d+$/.test(v)) return Number(v);
  throw new Error('TRUST_PROXY must be false, true or a number of trusted proxy hops');
}
