/**
 * Standard Webhooks (https://www.standardwebhooks.com/): signing for the sender and verification for receivers.
 * Web Crypto only (Node 22+, browsers, edge runtimes), no dependencies.
 *
 * Errors come in two kinds. A request that fails verification throws `WebhookVerificationError` (answer 400 and
 * move on). A receiver misconfiguration (a secret that isn't a valid `whsec_…`, a bad clock or tolerance) throws a
 * `TypeError` or `RangeError`, which should reach your error monitoring instead of turning every delivery into a 400.
 */

/** Why a request failed verification. Misconfiguration is not a verification failure (see above). */
export type WebhookVerificationReason =
  | 'missing_header'
  | 'invalid_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'no_matching_signature'
  | 'invalid_payload';

export class WebhookVerificationError extends Error {
  constructor(readonly reason: WebhookVerificationReason) {
    super(`Webhook verification failed: ${reason}`);
    this.name = 'WebhookVerificationError';
  }
}

export interface SignWebhookOptions {
  id: string;
  /** Integer Unix seconds, also sent as webhook-timestamp. */
  timestamp: number;
  /** Exact raw request body; do not parse and reserialize it. */
  payload: string;
  secrets: readonly string[];
}

/** A Fetch `Headers` (or anything with `get`), or a plain record such as Node's `req.headers`. */
export type WebhookHeaders = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

export type VerifyWebhookOptions = {
  payload: string;
  headers: WebhookHeaders;
  toleranceSeconds?: number;
  /** Current Unix time in seconds; defaults to the current whole second. */
  now?: number;
} & ({ secret: string; secrets?: never } | { secret?: never; secrets: readonly string[] });

/** Signatures checked per request: enough for any rotation overlap, bounded against a header stuffed with junk. */
const MAX_SIGNATURES = 10;
const SIGNATURE_BYTES = 32;

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return;
  try {
    const decoded = atob(value);
    if (btoa(decoded).replace(/[=]+$/, '') !== value.replace(/[=]+$/, '')) return;
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  } catch {
    // Malformed base64: the caller treats it as a skipped signature or a configuration error.
  }
}

/** Decodes `whsec_…` secrets. A malformed one is the receiver's configuration error, not the request's. */
function decodeSecrets(secrets: readonly unknown[]): Uint8Array<ArrayBuffer>[] {
  if (secrets.length === 0) throw new TypeError('At least one webhook secret is required.');
  return secrets.map((secret) => {
    if (typeof secret !== 'string') throw new TypeError('A webhook secret must be a string such as "whsec_…".');
    const key = secret.startsWith('whsec_') ? decodeBase64(secret.slice(6)) : undefined;
    // Standard Webhooks symmetric keys contain 24–64 random bytes.
    if (!key || key.length < 24 || key.length > 64) {
      throw new TypeError('A webhook secret must be "whsec_" followed by 24–64 bytes in base64.');
    }
    return key;
  });
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function hmac(key: Uint8Array<ArrayBuffer>, message: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, message));
}

/** Compares two equal-length byte strings in constant time (no early exit on the first difference). */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] as number) ^ (b[index] as number);
  }
  return difference === 0;
}

function signedContent(id: string, timestamp: string | number, payload: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${id}.${timestamp}.${payload}`);
}

/** Returns the `webhook-signature` header value: one `v1,<base64>` per secret, space-separated (rotation overlap). */
export async function signWebhook({ id, timestamp, payload, secrets }: SignWebhookOptions): Promise<string> {
  if (!id || id.includes('.') || /[\r\n]/.test(id)) throw new TypeError('Webhook id must be nonempty and contain no dots or newlines.');
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new RangeError('Webhook timestamp must be whole Unix seconds.');
  const message = signedContent(id, timestamp, payload);
  const signatures: string[] = [];
  for (const key of decodeSecrets(secrets)) {
    signatures.push(`v1,${encodeBase64(await hmac(key, message))}`);
  }
  return signatures.join(' ');
}

function getHeader(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const value = Object.entries(headers as Record<string, string | string[] | undefined>).find(([key]) => key.toLowerCase() === name)?.[1];
  // Node gives repeated headers as arrays; a webhook header sent twice is ambiguous, so it counts as missing.
  return typeof value === 'string' ? value : undefined;
}

/**
 * Authenticates the raw body, then parses it as JSON and returns it. The body is not validated against a schema; pass
 * the type you expect (for Logbird, the delivery shape documented in docs/webhooks.md).
 */
export async function verifyWebhook<T = unknown>(options: VerifyWebhookOptions): Promise<T> {
  const { payload, headers, toleranceSeconds = 300, now = Math.floor(Date.now() / 1000) } = options;
  // Configuration first, so a broken secret or clock fails on the first request, whatever the request looks like.
  if (!Number.isFinite(now)) throw new RangeError('now must be finite Unix seconds.');
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) throw new RangeError('toleranceSeconds must be a finite number ≥ 0.');
  const keys = decodeSecrets(options.secrets ?? [options.secret]);

  const id = getHeader(headers, 'webhook-id');
  const timestamp = getHeader(headers, 'webhook-timestamp');
  const signatureHeader = getHeader(headers, 'webhook-signature');
  if (!id || !timestamp || !signatureHeader) throw new WebhookVerificationError('missing_header');
  const seconds = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(seconds)) throw new WebhookVerificationError('invalid_timestamp');
  if (Math.abs(now - seconds) > toleranceSeconds) throw new WebhookVerificationError('timestamp_out_of_tolerance');

  const candidates: Uint8Array[] = [];
  for (const entry of signatureHeader.split(/\s+/)) {
    if (candidates.length === MAX_SIGNATURES) break;
    if (!entry.startsWith('v1,')) continue;
    const signature = decodeBase64(entry.slice(3));
    if (signature?.length === SIGNATURE_BYTES) candidates.push(signature);
  }
  // One HMAC of the body per secret, however many signatures the header claims.
  const message = signedContent(id, timestamp, payload);
  let matched = false;
  for (const key of keys) {
    const expected = await hmac(key, message);
    for (const candidate of candidates) {
      matched = equalBytes(candidate, expected) || matched;
    }
  }
  if (!matched) throw new WebhookVerificationError('no_matching_signature');
  try {
    return JSON.parse(payload) as T;
  } catch {
    throw new WebhookVerificationError('invalid_payload');
  }
}

/** A new endpoint secret: `whsec_` and 32 random bytes in base64. */
export function generateWebhookSecret(): string {
  return `whsec_${encodeBase64(crypto.getRandomValues(new Uint8Array(32)))}`;
}
