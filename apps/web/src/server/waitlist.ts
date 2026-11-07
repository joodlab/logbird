import { type WaitlistRecord, waitlistSchema } from '../lib/waitlist-schema';

const MAX_BODY = 8192;
interface WaitlistDependencies {
  store: (record: WaitlistRecord) => Promise<void>;
  allowedOrigin: string;
  /** The adapter must use a trusted platform/socket address, never an arbitrary forwarding header. */
  ip: string;
  limiter: ReturnType<typeof createRateLimiter>;
  now?: () => number;
}
export function createRateLimiter() {
  const clients = new Map<string, { count: number; until: number }>();
  return (ip: string, now: number) => {
    for (const [key, value] of clients) {
      if (value.until <= now) {
        clients.delete(key);
      }
    }
    const bucket = clients.get(ip) ?? { count: 0, until: now + 60_000 };
    bucket.count += 1;
    clients.set(ip, bucket);
    return bucket.count <= 5;
  };
}
export async function handleWaitlist(request: Request, deps: WaitlistDependencies): Promise<Response> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const form = contentType === 'application/x-www-form-urlencoded';
  const respond = (status: number, code?: string, message?: string, details?: unknown) => {
    if (form) {
      const outcome = status === 200 ? 'ok' : 'error';
      return new Response(null, {
        status: 303,
        // A fragment gives static HTML a no-JS feedback target; query state is used after hydration.
        headers: { Location: `/contact?status=${outcome}#waitlist-${outcome}`, 'Cache-Control': 'no-store' },
      });
    }
    return Response.json(code ? { error: { code, message, ...(details ? { details } : {}) } } : { ok: true }, {
      status,
      headers: { 'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': '60' } : {}) },
    });
  };
  const origin = request.headers.get('origin');
  if (origin && origin !== deps.allowedOrigin) {
    return respond(400, 'invalid_origin', 'Submit this form from the website.');
  }
  if (!deps.limiter(deps.ip, (deps.now ?? Date.now)())) {
    return respond(429, 'rate_limited', 'Please wait a minute before trying again.');
  }
  if (contentType !== 'application/json' && !form) {
    return respond(415, 'unsupported_media_type', 'Use JSON or a URL-encoded form.');
  }
  const length = Number(request.headers.get('content-length'));
  if (length > MAX_BODY) {
    return respond(413, 'body_too_large', 'The request exceeds 8 KB.');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > MAX_BODY) {
          await reader.cancel();
          return respond(413, 'body_too_large', 'The request exceeds 8 KB.');
        }
        chunks.push(value);
      }
    } catch {
      return respond(400, 'invalid_body', 'The request body could not be read.');
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let input: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    input = form ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text);
  } catch {
    return respond(400, 'invalid_body', 'The request body is invalid.');
  }
  // Bots receive the same success response without touching storage or SMTP.
  if (input && typeof input === 'object' && 'website' in input && typeof input.website === 'string' && input.website.length > 0) {
    return respond(200);
  }
  const parsed = waitlistSchema.safeParse(input);
  if (!parsed.success) {
    return respond(400, 'validation_error', 'Check the highlighted fields.', parsed.error.flatten().fieldErrors);
  }
  const { website: _honeypot, ...fields } = parsed.data;
  try {
    await deps.store({ receivedAt: new Date((deps.now ?? Date.now)()).toISOString(), ...fields });
  } catch {
    return respond(503, 'waitlist_unavailable', 'The waitlist is unavailable on this deployment.');
  }
  return respond(200);
}
