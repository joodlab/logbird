import { lookup } from 'node:dns/promises';
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
export type WebhookLookup = (hostname: string, options: { all: true }) => Promise<{ address: string; family: number }[]>;

/** `dns.lookup` runs getaddrinfo on libuv's small thread pool (4 threads by default), shared with fs, crypto and password
 * hashing. A hostname whose nameserver never answers holds a thread for the resolver's own timeout, so save-time lookups
 * get a deadline and at most two pool threads per process; requests over that wait for a slot within the same deadline. */
export const WEBHOOK_LOOKUP_TIMEOUT_MS = 3000;
const MAX_CONCURRENT_LOOKUPS = 2;
let activeLookups = 0;
const lookupWaiters: (() => void)[] = [];
function releaseLookup() {
  // The slot passes straight to the next waiter, if any.
  const next = lookupWaiters.shift();
  if (next) next();
  else activeLookups--;
}
function acquireLookup(ms: number) {
  if (activeLookups < MAX_CONCURRENT_LOOKUPS) {
    activeLookups++;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const grant = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      lookupWaiters.splice(lookupWaiters.indexOf(grant), 1);
      resolve(false);
    }, ms);
    lookupWaiters.push(grant);
  });
}
async function boundedLookup(resolve: WebhookLookup, hostname: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  if (!(await acquireLookup(timeoutMs))) throw new WebhookUrlError('Webhook hostname lookup timed out; try again.');
  // The slot is held until the lookup really settles, not just until the deadline: its pool thread is busy until then.
  const pending = Promise.resolve().then(() => resolve(hostname, { all: true }));
  pending.then(releaseLookup, releaseLookup);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WebhookUrlError('Webhook hostname lookup timed out; try again.')), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Save-time check only. Senders must resolve and pin an allowed address again at connect time. */
export async function validateWebhookUrl(
  raw: string,
  allowHttp = false,
  resolve: WebhookLookup = lookup,
  timeoutMs = WEBHOOK_LOOKUP_TIMEOUT_MS,
): Promise<string> {
  const reject = (reason: string): never => {
    throw new WebhookUrlError(reason);
  };
  if (raw.length > 2048) reject('Webhook URL exceeds 2048 characters.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject('Webhook URL must be an absolute URL.');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) reject('Webhook URL must use HTTPS.');
  if (url.username || url.password) reject('Webhook URL must not contain credentials.');
  if (raw.includes('#')) reject('Webhook URL must not contain a fragment.');
  if (url.port === '0') reject('Webhook URL port must be between 1 and 65535.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (!isAllowedWebhookAddress(hostname)) reject('Webhook URL address is not public unicast.');
  } else {
    let addresses: Awaited<ReturnType<WebhookLookup>>;
    try {
      addresses = await boundedLookup(resolve, hostname, timeoutMs);
    } catch (error) {
      if (error instanceof WebhookUrlError) throw error;
      return reject('Webhook hostname could not be resolved.');
    }
    if (!addresses.length || addresses.some(({ address }) => !isAllowedWebhookAddress(address)))
      reject('Webhook hostname must resolve only to public unicast addresses.');
  }
  return url.href;
}
