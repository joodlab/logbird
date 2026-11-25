import type { AuditEvent, ChangeValueKind } from '@logbird/contracts';

export type EventChange = AuditEvent['changes'][number];

export const REDACTED_CHANGE_VALUE = '[redacted]';
export const CHANGE_VALUE_WRAP = '[overflow-wrap:anywhere]';

export const changeFieldLabel = (field: string) => field || 'Unnamed field';

export function changeValueText(text: string, kind?: ChangeValueKind): string {
  if (text === REDACTED_CHANGE_VALUE) return 'value redacted';
  if (kind === 'absent') return 'not set';
  if (kind === 'null') return 'null';
  if (kind === 'string') return JSON.stringify(text);
  return text || '∅';
}

/** Keep whitespace visible in compact views while full values retain the stored text. */
export function changeValuePreview(text: string, kind?: ChangeValueKind): string {
  const value = changeValueText(text, kind);
  return kind === undefined ? value.replace(/\r\n|[\r\n\t]/g, (character) => (character === '\t' ? '⇥' : '↵')) : value;
}

export function middleTruncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const start = Math.floor(limit / 2);
  const end = limit - start - 1;
  return `${text.slice(0, start).replace(/[\uD800-\uDBFF]$/u, '')}…${text.slice(-end).replace(/^[\uDC00-\uDFFF]/u, '')}`;
}

export function changeDisplayParts(change: EventChange) {
  const present = (text: string, kind?: ChangeValueKind) => (kind === undefined ? text !== '' : kind !== 'absent');
  if (change.beforeKind === 'absent' && present(change.after, change.afterKind)) return { before: false, after: true };
  if (change.afterKind === 'absent' && present(change.before, change.beforeKind)) return { before: true, after: false };
  return { before: true, after: true };
}
