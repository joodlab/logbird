import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import * as ch from '@logbird/clickhouse';
import { type AuditEvent, type ReadScope, readScopeSchema } from '@logbird/contracts';
import { type ApiKey, type Project, prisma } from '@logbird/database';
import { z } from 'zod';
import { env } from './env';
import { ApiError } from './errors';

/**
 * Scoped read access (#138): who is reading through /v1 and within which scope.
 * - `key`: a `read` key (scope null = whole project) or a `scoped-read` key (its fixed scope).
 * - `token`: a viewer token minted by a read key; the scope is the token's (equal to or narrower than the key's).
 */
export type Reader = {
  via: 'key' | 'token';
  keyId: string;
  keyName: string;
  scope: ReadScope | null;
  embedOrigins: string[];
  jti?: string;
};

/** The stored scope of a key. A malformed stored scope fails closed: the key cannot be used at all. */
export function storedScope(key: Pick<ApiKey, 'scope'>): ReadScope | null | undefined {
  if (key.scope === null || key.scope === undefined) return null;
  const parsed = readScopeSchema.safeParse(key.scope);
  return parsed.success ? parsed.data : undefined;
}
export const keyUsable = (key: Pick<ApiKey, 'revokedAt' | 'expiresAt'>, now = Date.now()) =>
  !key.revokedAt && (!key.expiresAt || key.expiresAt.getTime() > now);

/**
 * Whether `child` is equal to or narrower than `parent` (null = the whole project). Narrower means: same tenant; the
 * parent's target if it has one; every child action prefix inside some parent prefix; and at least the parent's masks.
 */
export function scopeWithin(child: ReadScope, parent: ReadScope | null): boolean {
  if (!parent) return true;
  if (child.tenantId !== parent.tenantId) return false;
  if (parent.target && (child.target?.type !== parent.target.type || child.target?.id !== parent.target.id)) return false;
  if (parent.actionPrefixes) {
    if (!child.actionPrefixes) return false;
    if (!child.actionPrefixes.every((prefix) => parent.actionPrefixes?.some((allowed) => prefix.startsWith(allowed)))) return false;
  }
  if (parent.mask?.some((mask) => !child.mask?.includes(mask))) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Viewer tokens: lbv1.<base64url(payload)>.<base64url(HMAC-SHA256)>   */
/* ------------------------------------------------------------------ */

export const VIEWER_TOKEN_PREFIX = 'lbv1';
const SKEW_MS = 30_000;
const MAX_TOKEN_LENGTH = 8192;
/** HKDF-SHA256 from BETTER_AUTH_SECRET (empty salt, info `logbird-viewer-token-v1`); see docs/security.md. */
export const viewerTokenKey = (authSecret: string) => Buffer.from(hkdfSync('sha256', authSecret, '', 'logbird-viewer-token-v1', 32));
const payloadSchema = z
  .object({
    v: z.literal(1),
    kid: z.string().min(1),
    p: z.string().min(1),
    s: readScopeSchema,
    iat: z.number().int(),
    exp: z.number().int(),
    jti: z.string().min(1),
  })
  .strict();
export type ViewerTokenPayload = z.infer<typeof payloadSchema>;
const mac = (secret: Buffer, body: string) => createHmac('sha256', secret).update(body).digest();

export function mintViewerToken(
  input: { keyId: string; projectId: string; scope: ReadScope; ttlSeconds: number },
  secret = defaultTokenKey(),
  now = Date.now(),
) {
  const iat = Math.floor(now / 1000);
  const payload: ViewerTokenPayload = {
    v: 1,
    kid: input.keyId,
    p: input.projectId,
    s: input.scope,
    iat,
    exp: iat + input.ttlSeconds,
    jti: randomUUID(),
  };
  const body = `${VIEWER_TOKEN_PREFIX}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const token = `${body}.${mac(secret, body).toString('base64url')}`;
  // Same budget as verification: never hand out a token the read routes would refuse.
  if (token.length > MAX_TOKEN_LENGTH)
    throw new ApiError(
      422,
      'validation_error',
      `This scope makes a token longer than ${MAX_TOKEN_LENGTH} characters. Use fewer or shorter action prefixes.`,
    );
  return { token, expiresAt: new Date(payload.exp * 1000).toISOString(), payload };
}

/** A token's verified payload, or null (bad shape, bad MAC, expired, issued in the future). Constant-time MAC check. */
export function verifyViewerToken(token: string, secret = defaultTokenKey(), now = Date.now()): ViewerTokenPayload | null {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VIEWER_TOKEN_PREFIX || !parts[1] || !parts[2]) return null;
  const expected = mac(secret, `${parts[0]}.${parts[1]}`);
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: z.ZodSafeParseResult<ViewerTokenPayload>;
  try {
    parsed = payloadSchema.safeParse(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const { iat, exp } = parsed.data;
  if (exp * 1000 + SKEW_MS <= now || iat * 1000 - SKEW_MS > now || exp <= iat) return null;
  return parsed.data;
}
let tokenKeyCache: Buffer | undefined;
function defaultTokenKey() {
  tokenKeyCache ??= viewerTokenKey(env.BETTER_AUTH_SECRET);
  return tokenKeyCache;
}

/**
 * The minting key of a token, cached ≤ 30 s per process: revoking or expiring the key invalidates its tokens within
 * 30 s without a token table.
 */
const KEY_CACHE_MS = 30_000;
const keyCache = new Map<string, { at: number; key: (ApiKey & { project: Project }) | null }>();
export async function tokenKey(keyId: string, now = Date.now()) {
  const hit = keyCache.get(keyId);
  if (hit && now - hit.at < KEY_CACHE_MS) return hit.key;
  const key = await prisma.apiKey.findUnique({ where: { id: keyId }, include: { project: true } });
  if (keyCache.size >= 10_000) keyCache.clear();
  keyCache.set(keyId, { at: now, key });
  return key;
}
/** Tests only: forget cached keys. */
export const clearTokenKeyCache = () => keyCache.clear();

/* ------------------------------------------------------------------ */
/* Field masks                                                         */
/* ------------------------------------------------------------------ */

let maskKeyCache: Buffer | undefined;
const maskKey = () => {
  maskKeyCache ??= Buffer.from(hkdfSync('sha256', env.BETTER_AUTH_SECRET, '', 'logbird-field-mask-v1', 32));
  return maskKeyCache;
};
/** `actor_email` mask: a per-project keyed hash, stable for the same address so a viewer can still group by person. */
export const maskedEmail = (projectId: string, email: string, secret = maskKey()) =>
  email ? `masked:${createHmac('sha256', secret).update(`${projectId}\0${email.toLowerCase()}`).digest('hex').slice(0, 24)}` : '';
export function maskEvent(event: AuditEvent, mask: ReadScope['mask']): AuditEvent {
  if (!mask?.length) return event;
  const masked: AuditEvent = { ...event, context: { ...event.context }, attributes: { ...event.attributes } };
  if (mask.includes('ip')) masked.context.ip = '';
  if (mask.includes('user_agent')) masked.context.userAgent = '';
  if (mask.includes('actor_email') && masked.actor) masked.actor = { ...masked.actor, email: maskedEmail(event.projectId, masked.actor.email) };
  for (const preset of mask) for (const key of ch.MASKED_ATTRIBUTES[preset]) delete masked.attributes[key];
  return masked;
}

/**
 * A masked scope may not filter or group on a masked column or a masked attribute path: the result would reveal the
 * hidden value. Attribute paths are checked on the compiled query's bound attribute keys (`attributes[{qN:String}]`)
 * and on both facet levels, before anything reaches ClickHouse.
 */
export function assertNotMasked(scope: ReadScope | null, input: { q?: string; field?: string; by?: string }) {
  if (!scope?.mask?.length) return;
  const hidden = scope.mask.map((m) => ch.MASKED_COLUMNS[m]);
  const hiddenPaths = scope.mask.flatMap((m) => ch.MASKED_ATTRIBUTES[m]);
  const fail = (start: number | null, end: number | null) => {
    throw new ch.QueryError('This field is masked for this key or token.', {
      lang: 'query',
      reason: 'not_allowed',
      start,
      end,
      hint: 'Remove filters and facets on masked fields',
    });
  };
  if (input.q) {
    const compiled = ch.compileQuery(input.q);
    if (hidden.some((column) => new RegExp(`\\b${column}\\b`).test(compiled.sql))) fail(0, input.q.length);
    for (const [, key] of compiled.sql.matchAll(/(?:attributes\[|mapContains\(attributes,)\{(q\d+):String\}/g))
      if (key && hiddenPaths.includes(String(compiled.params[key]))) fail(0, input.q.length);
  }
  for (const field of [input.field, input.by]) {
    if (!field) continue;
    const column = ch.facetColumn(field);
    if (column && hidden.includes(column)) fail(null, null);
    if (!column && hiddenPaths.includes(field.replace(/^(attr|attributes)\./, ''))) fail(null, null);
  }
}
export const forbidMaskedEvidence = (scope: ReadScope | null, format: string) => {
  if (scope?.mask?.length && format === 'jsonl-evidence')
    throw new ApiError(422, 'masked_export', 'Evidence exports carry the original payload and are not available with field masks.');
};
