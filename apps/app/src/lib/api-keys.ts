import {
  type ApiKey,
  type ApiKeyKind,
  type createApiKeySchema,
  embedOriginSchema,
  type ReadScope,
  readScopeSchema,
  SCOPE_MASKS,
  type scopeMaskSchema,
} from '@logbird/contracts';
import type { z } from 'zod';

/** A key past its `expiresAt` is refused by the API like a revoked one (#138). */
export const isKeyExpired = (key: Pick<ApiKey, 'expiresAt'>, now = Date.now()) => Boolean(key.expiresAt && Date.parse(key.expiresAt) <= now);
/** Usable = not revoked and not expired: the only keys setup and rotation guidance may offer or rely on. */
export const isKeyUsable = (key: Pick<ApiKey, 'revokedAt' | 'expiresAt'>, now = Date.now()) => !key.revokedAt && !isKeyExpired(key, now);

const DAY_MS = 86_400_000;
/** A usable key that expires within this window is flagged in the list. */
export const EXPIRY_WARNING_DAYS = 7;
export const expiresSoon = (key: Pick<ApiKey, 'revokedAt' | 'expiresAt'>, now = Date.now()) =>
  isKeyUsable(key, now) && key.expiresAt !== null && Date.parse(key.expiresAt) - now <= EXPIRY_WARNING_DAYS * DAY_MS;

export type ScopeMask = z.infer<typeof scopeMaskSchema>;
export type CreateKeyBody = z.input<typeof createApiKeySchema>;

/** The contract's limits (`readScopeSchema`, `createApiKeySchema`), shown next to each field before submit. */
export const SCOPE_LIMITS = { tenantId: 250, targetType: 60, targetId: 250, actionPrefix: 190, actionPrefixes: 20, embedOrigins: 10 } as const;

export const MASK_LABEL: Record<ScopeMask, string> = { ip: 'IP address', user_agent: 'User agent', actor_email: 'Actor email' };
export const MASK_HINT: Record<ScopeMask, string> = {
  ip: 'context.ip is emptied',
  user_agent: 'context.userAgent is emptied',
  actor_email: 'actor.email becomes a stable hash, so a viewer can still group by person',
};

/** Expiry choices. The console sends an absolute instant computed when the form is submitted. */
export const KEY_EXPIRY_PRESETS = [
  { id: 'never', label: 'Never', days: null },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: '1y', label: '1 year', days: 365 },
] as const;
export type KeyExpiryPreset = (typeof KEY_EXPIRY_PRESETS)[number]['id'];
export function expiryFor(preset: KeyExpiryPreset, now = Date.now()): string | undefined {
  const days = KEY_EXPIRY_PRESETS.find((p) => p.id === preset)?.days;
  return days ? new Date(now + days * DAY_MS).toISOString() : undefined;
}

export type KeyFormValues = {
  name: string;
  kind: ApiKeyKind;
  tenantId: string;
  targetType: string;
  targetId: string;
  /** One prefix per line. */
  actionPrefixes: string;
  masks: ScopeMask[];
  /** One origin per line. */
  embedOrigins: string;
  expiry: KeyExpiryPreset;
};
export const EMPTY_KEY_FORM: KeyFormValues = {
  name: '',
  kind: 'ingest',
  tenantId: '',
  targetType: '',
  targetId: '',
  actionPrefixes: '',
  masks: [],
  embedOrigins: '',
  expiry: 'never',
};
export type KeyFormField = keyof KeyFormValues;

/** Non-blank lines, exactly as typed (no trimming: scope ids must be in stored form, and the check says so). */
export const listLines = (text: string): string[] => text.split(/\r?\n/).filter((line) => line.trim() !== '');

const INVALID_UNICODE = /�|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** The contract's `scopeIdentifier` rule, with a message that names the problem. */
export function checkScopeId(value: string, max: number): string | undefined {
  if (value.length > max) return `At most ${max} characters (this has ${value.length}).`;
  if (value !== value.trim()) return 'Remove the spaces at the start or end: use the id exactly as stored.';
  if (value.includes(String.fromCharCode(0)) || INVALID_UNICODE.test(value)) return 'Contains characters Logbird never stores (NUL or invalid Unicode).';
  return undefined;
}

const isReadKind = (kind: ApiKeyKind) => kind !== 'ingest';

/** Field errors for the create form. Empty when the body built by `createKeyBody` is valid for the contract. */
export function validateKeyForm(v: KeyFormValues): Partial<Record<KeyFormField, string>> {
  const errors: Partial<Record<KeyFormField, string>> = {};
  if (v.kind === 'scoped-read') {
    errors.tenantId = v.tenantId === '' ? 'Enter the tenant id this key may read.' : checkScopeId(v.tenantId, SCOPE_LIMITS.tenantId);
    if (v.targetType !== '' || v.targetId !== '') {
      errors.targetType = v.targetType === '' ? 'Enter the target type too, or clear the target id.' : checkScopeId(v.targetType, SCOPE_LIMITS.targetType);
      errors.targetId = v.targetId === '' ? 'Enter the target id too, or clear the target type.' : checkScopeId(v.targetId, SCOPE_LIMITS.targetId);
    }
    const prefixes = listLines(v.actionPrefixes);
    if (prefixes.length > SCOPE_LIMITS.actionPrefixes) errors.actionPrefixes = `At most ${SCOPE_LIMITS.actionPrefixes} prefixes (this has ${prefixes.length}).`;
    else {
      const bad = prefixes.map((p, i) => [i, checkScopeId(p, SCOPE_LIMITS.actionPrefix)] as const).find(([, m]) => m);
      if (bad) errors.actionPrefixes = `Line ${bad[0] + 1}: ${bad[1]}`;
    }
  }
  if (isReadKind(v.kind)) {
    const origins = listLines(v.embedOrigins);
    if (origins.length > SCOPE_LIMITS.embedOrigins) errors.embedOrigins = `At most ${SCOPE_LIMITS.embedOrigins} origins (this has ${origins.length}).`;
    else {
      const bad = origins.findIndex((o) => !embedOriginSchema.safeParse(o).success);
      if (bad >= 0) errors.embedOrigins = `Line ${bad + 1}: use a lowercase origin such as https://app.example.com (no path or trailing slash).`;
    }
  }
  for (const k of Object.keys(errors) as KeyFormField[]) if (!errors[k]) delete errors[k];
  if (v.kind === 'scoped-read' && Object.keys(errors).length === 0 && !readScopeSchema.safeParse(formScope(v)).success)
    errors.tenantId = 'This scope is not valid. Check each field against its limits.';
  return errors;
}

/** The scope the form describes (only meaningful for `scoped-read`). */
export function formScope(v: KeyFormValues): ReadScope {
  const prefixes = listLines(v.actionPrefixes);
  return {
    tenantId: v.tenantId,
    ...(v.targetType !== '' || v.targetId !== '' ? { target: { type: v.targetType, id: v.targetId } } : {}),
    ...(prefixes.length ? { actionPrefixes: prefixes } : {}),
    ...(v.masks.length ? { mask: SCOPE_MASKS.filter((m) => v.masks.includes(m)) } : {}),
  };
}

export function createKeyBody(v: KeyFormValues, now = Date.now()): CreateKeyBody {
  const origins = isReadKind(v.kind) ? listLines(v.embedOrigins) : [];
  const expiresAt = expiryFor(v.expiry, now);
  return {
    name: v.name.trim(),
    kind: v.kind,
    ...(v.kind === 'scoped-read' ? { scope: formScope(v) } : {}),
    ...(origins.length ? { embedOrigins: origins } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

const sameSet = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && a.every((x) => b.includes(x));
export function sameScope(a: ReadScope | null | undefined, b: ReadScope | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.tenantId === b.tenantId &&
    a.target?.type === b.target?.type &&
    a.target?.id === b.target?.id &&
    sameSet(a.actionPrefixes, b.actionPrefixes) &&
    sameSet(a.mask, b.mask)
  );
}
const sameInstant = (a: string | null | undefined, b: string | null | undefined) =>
  !a || !b ? !a && !b : Math.abs(Date.parse(a) - Date.parse(b)) < 1000;

/** What the server should have granted: the create request, or (after a roll) the old key with an optional new expiry. */
export type ExpectedGrant = { kind: ApiKeyKind; scope: ReadScope | null; embedOrigins: string[]; expiresAt: string | null };
export const expectedFromBody = (body: CreateKeyBody): ExpectedGrant => ({
  kind: body.kind,
  scope: body.scope ?? null,
  embedOrigins: body.embedOrigins ?? [],
  expiresAt: body.expiresAt ?? null,
});
export const expectedFromRoll = (old: ApiKey, expiresAt: string | undefined): ExpectedGrant => ({
  kind: old.kind,
  scope: old.scope,
  embedOrigins: old.embedOrigins,
  expiresAt: expiresAt ?? old.expiresAt,
});

/**
 * Which parts of the returned key differ from what was asked for. A server older than scoped keys ignores an expiry
 * and returns a permanent key (docs/scoped-read-access.md): the console says so instead of handing that secret out.
 */
export function grantDifferences(expected: ExpectedGrant, key: ApiKey): string[] {
  const out: string[] = [];
  if (expected.kind !== key.kind) out.push('permission');
  if (!sameScope(expected.scope, key.scope)) out.push('scope');
  if (!sameSet(expected.embedOrigins, key.embedOrigins)) out.push('embed origins');
  if (!sameInstant(expected.expiresAt, key.expiresAt)) out.push('expiry');
  return out;
}
