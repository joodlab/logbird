import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Conservative public-unicast policy; WHATWG normalizes decimal/octal/hex IPv4.
 * Special-purpose ranges: https://www.iana.org/assignments/iana-ipv4-special-registry/
 * and https://www.iana.org/assignments/iana-ipv6-special-registry/.
 */
export function isAllowedWebhookAddress(address: string): boolean {
  if (/[/?#@\s]/.test(address)) return false;
  let host: string;
  try {
    host = new URL(`http://${address.includes(':') && !address.startsWith('[') ? `[${address}]` : address}/`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (isIP(host) === 4) {
    const [a = 0, b = 0, c = 0] = host.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(host) !== 6) return false;
  const [left = '', right] = host.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const words = right === undefined ? head : [...head, ...new Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  const value = words.reduce((n, word) => (n << 16n) | BigInt(`0x${word}`), 0n);
  // IPv4-mapped and well-known NAT64: apply the IPv4 policy to the embedded address.
  if (value >> 32n === 0xffffn || value >> 32n === 0x64ff9b0000000000000000n) {
    return isAllowedWebhookAddress([24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join('.'));
  }
  // Only global unicast; excludes ULA, metadata, link-local, multicast, unspecified,
  // IPv4-compatible/translatable forms and local-use NAT64 (64:ff9b:1::/48).
  if (value >> 125n !== 1n) return false;
  // IETF protocol assignments (2001::/23), documentation (2001:db8::/32, 3fff::/20), and 6to4.
  return !(value >> 105n === 0x100080n || value >> 96n === 0x20010db8n || value >> 112n === 0x2002n || value >> 108n === 0x3fff0n);
}

export class WebhookUrlError extends Error {
  readonly code = 'webhook_url_not_allowed';
}
export class WebhookLookupBusyError extends Error {
  readonly code = 'webhook_lookup_busy';
}
export type WebhookLookup = (hostname: string, options: { all: true }) => Promise<{ address: string; family: number }[]>;

export const WEBHOOK_LOOKUP_TIMEOUT_MS = 3000;
const MAX_LOOKUPS = 64;
const MAX_ORG_LOOKUPS = 2;
const activeByOrg = new Map<string, number>();
let activeLookups = 0;

async function resolveAddresses(hostname: string): ReturnType<WebhookLookup> {
  // c-ares does not occupy the libuv pool. A resolver belongs to one lookup, so cancel never affects another tenant.
  const resolver = new Resolver({ timeout: WEBHOOK_LOOKUP_TIMEOUT_MS, tries: 1 });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    resolver.cancel();
  }, WEBHOOK_LOOKUP_TIMEOUT_MS);
  try {
    const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    if (timedOut) throw new WebhookLookupBusyError('Webhook hostname lookup timed out; try again.');
    return answers.flatMap((answer, index) => {
      if (answer.status === 'fulfilled') return answer.value.map((address) => ({ address, family: index === 0 ? 4 : 6 }));
      const code = (answer.reason as NodeJS.ErrnoException).code;
      if (code === 'ENODATA' || code === 'ENOTFOUND') return [];
      if (code === 'ETIMEOUT') throw new WebhookLookupBusyError('Webhook hostname lookup timed out; try again.');
      throw answer.reason;
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Shared URL and public-address checks. The sender must connect using the returned address only. */
export async function resolveWebhookDestination(
  raw: string,
  {
    allowHttp = false,
    lookup = resolveAddresses,
    allowAddress = isAllowedWebhookAddress,
  }: { allowHttp?: boolean; lookup?: WebhookLookup; allowAddress?: (address: string) => boolean } = {},
) {
  if (raw.length > 2048) throw new WebhookUrlError('Webhook URL exceeds 2048 characters.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError('Webhook URL must be an absolute URL.');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw new WebhookUrlError('Webhook URL must use HTTPS.');
  if (url.username || url.password) throw new WebhookUrlError('Webhook URL must not contain credentials.');
  if (raw.includes('#')) throw new WebhookUrlError('Webhook URL must not contain a fragment.');
  if (url.port === '0') throw new WebhookUrlError('Webhook URL port must be between 1 and 65535.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  let addresses: Awaited<ReturnType<WebhookLookup>>;
  try {
    addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true });
  } catch (error) {
    if (error instanceof WebhookLookupBusyError) throw error;
    throw new WebhookUrlError('Webhook hostname could not be resolved.');
  }
  const first = addresses[0];
  if (!first || addresses.some(({ address, family: version }) => !version || isIP(address) !== version || !allowAddress(address)))
    throw new WebhookUrlError('Webhook hostname must resolve only to public unicast addresses.');
  return { url, ...first };
}

/** Enforce separate per-workspace budgets before doing asynchronous DNS. Literal IPs need no slot. */
export async function validateWebhookUrl(raw: string, allowHttp = false, resolve: WebhookLookup = resolveAddresses, organizationId = '') {
  const lookup: WebhookLookup = async (hostname, options) => {
    const active = activeByOrg.get(organizationId) ?? 0;
    if (active >= MAX_ORG_LOOKUPS || activeLookups >= MAX_LOOKUPS) throw new WebhookLookupBusyError('Webhook hostname lookup is busy; try again.');
    activeByOrg.set(organizationId, active + 1);
    activeLookups++;
    try {
      return await resolve(hostname, options);
    } finally {
      activeLookups--;
      const remaining = (activeByOrg.get(organizationId) ?? 1) - 1;
      if (remaining) activeByOrg.set(organizationId, remaining);
      else activeByOrg.delete(organizationId);
    }
  };
  return (await resolveWebhookDestination(raw, { allowHttp, lookup })).url.href;
}
