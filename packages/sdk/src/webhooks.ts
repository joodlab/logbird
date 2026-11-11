import type { AuditEvent } from './read';

export type WebhookVerificationReason =
  | 'missing_header'
  | 'invalid_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'no_matching_signature'
  | 'invalid_secret'
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

export type WebhookHeaders = Headers | Record<string, string | undefined>;

export type VerifyWebhookOptions = {
  payload: string;
  headers: WebhookHeaders;
  toleranceSeconds?: number;
  /** Current Unix time in seconds; defaults to Date.now() / 1000. */
  now?: number;
} & ({ secret: string; secrets?: never } | { secret?: never; secrets: readonly string[] });

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return;
  try {
    const decoded = atob(value);
    if (btoa(decoded).replace(/[=]+$/, '') !== value.replace(/[=]+$/, '')) return;
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  } catch {
    // Malformed base64 is handled by the caller's typed error or skipped signature.
  }
}

function decodeSecrets(secrets: readonly string[]): Uint8Array<ArrayBuffer>[] {
  if (secrets.length === 0) throw new WebhookVerificationError('invalid_secret');
  return secrets.map((secret) => {
    const key = secret.startsWith('whsec_') ? decodeBase64(secret.slice(6)) : undefined;
    // Standard Webhooks symmetric keys contain 24–64 random bytes.
    if (!key || key.length < 24 || key.length > 64) throw new WebhookVerificationError('invalid_secret');
    return key;
  });
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function importKey(key: Uint8Array<ArrayBuffer>, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** Dependency-free Web Crypto works in Node 22+, browsers and edge runtimes. */
export async function signWebhook({ id, timestamp, payload, secrets }: SignWebhookOptions): Promise<string> {
  if (!id || id.includes('.') || /[\r\n]/.test(id)) throw new TypeError('Webhook id must be nonempty and contain no dots or newlines');
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new WebhookVerificationError('invalid_timestamp');
  const keys = decodeSecrets(secrets);
  const message = new TextEncoder().encode(`${id}.${timestamp}.${payload}`);
  const signatures: string[] = [];
  for (const key of keys) {
    const signature = await crypto.subtle.sign('HMAC', await importKey(key, 'sign'), message);
    signatures.push(`v1,${encodeBase64(new Uint8Array(signature))}`);
  }
  return signatures.join(' ');
}

function getHeader(headers: WebhookHeaders, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

/** Authenticates the raw body before JSON parsing; does not validate the event schema. */
export async function verifyWebhook(options: VerifyWebhookOptions): Promise<AuditEvent> {
  const { payload, headers, toleranceSeconds = 300, now = Date.now() / 1000 } = options;
  const id = getHeader(headers, 'webhook-id');
  const timestamp = getHeader(headers, 'webhook-timestamp');
  const signatureHeader = getHeader(headers, 'webhook-signature');
  if (!id || !timestamp || !signatureHeader) throw new WebhookVerificationError('missing_header');
  const seconds = Number(timestamp);
  if (
    !/^\d+$/.test(timestamp) ||
    !Number.isSafeInteger(seconds) ||
    !Number.isFinite(now) ||
    !Number.isFinite(toleranceSeconds) ||
    toleranceSeconds < 0
  )
    throw new WebhookVerificationError('invalid_timestamp');
  if (Math.abs(now - seconds) > toleranceSeconds) throw new WebhookVerificationError('timestamp_out_of_tolerance');

  const keys = decodeSecrets(options.secrets ?? [options.secret]);
  const signatures: Uint8Array<ArrayBuffer>[] = [];
  for (const entry of signatureHeader.split(/\s+/)) {
    if (!entry.startsWith('v1,')) continue;
    const signature = decodeBase64(entry.slice(3));
    if (signature?.length === 32) signatures.push(signature);
  }
  const message = new TextEncoder().encode(`${id}.${timestamp}.${payload}`);
  // Web Crypto's HMAC verify compares in constant time and exists in Node 22+, browsers and edge runtimes alike, so
  // the SDK needs no `node:crypto` import that a browser bundler would have to externalize.
  for (const key of keys) {
    const verificationKey = await importKey(key, 'verify');
    for (const signature of signatures) {
      if (await crypto.subtle.verify('HMAC', verificationKey, signature, message)) {
        try {
          return JSON.parse(payload) as AuditEvent;
        } catch {
          throw new WebhookVerificationError('invalid_payload');
        }
      }
    }
  }
  throw new WebhookVerificationError('no_matching_signature');
}

export function generateWebhookSecret(): string {
  return `whsec_${encodeBase64(crypto.getRandomValues(new Uint8Array(32)))}`;
}
