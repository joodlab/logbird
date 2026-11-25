import type { AuditEvent, ChangeValueKind } from '@logbird/contracts';

export type EventChange = AuditEvent['changes'][number];

export const REDACTED_CHANGE_VALUE = '[redacted]';

export const changeFieldLabel = (field: string) => field || 'Unnamed field';

export function changeValueText(text: string, kind?: ChangeValueKind): string {
  if (text === REDACTED_CHANGE_VALUE) return 'value redacted';
  if (kind === 'absent') return 'not set';
  if (kind === 'null') return 'null';
  if (kind === 'string') return JSON.stringify(text);
  return text || '∅';
}

export function middleTruncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const start = Math.floor(limit / 2);
  const end = limit - start - 1;
  return `${text.slice(0, start).replace(/[\uD800-\uDBFF]$/u, '')}…${text.slice(-end).replace(/^[\uDC00-\uDFFF]/u, '')}`;
}

export function changeDisplayParts(change: EventChange) {
  if (change.beforeKind === 'absent' && change.afterKind !== 'absent') return { before: false, after: true };
  if (change.afterKind === 'absent' && change.beforeKind !== 'absent') return { before: true, after: false };
  return { before: true, after: true };
}
