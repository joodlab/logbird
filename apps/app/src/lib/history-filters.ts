import { andQuery, canonicalField, fieldTerms, formatTerm, hasTopLevelOr, removeTokens } from './query-language';

type HistoryField = 'changes.field' | 'tenant';

/** Exact terms that constrain the whole history can be replaced or removed by its controls. */
export function historyFilterTerms(query: string, field: HistoryField) {
  if (hasTopLevelOr(query)) return [];
  return fieldTerms(query, true).filter(
    (term) =>
      canonicalField(term.field ?? '') === field && !term.negated && !term.wildcard && (term.valueKind === 'plain' || term.valueKind === 'quoted'),
  );
}

export function removeHistoryFilter(query: string, field: HistoryField, value?: string) {
  const positions = new Set(
    historyFilterTerms(query, field)
      .filter((term) => value === undefined || term.value === value)
      .map((term) => term.start),
  );
  return positions.size ? removeTokens(query, (term) => positions.has(term.start)) : query;
}

export function applyHistoryFilter(query: string, field: HistoryField, value: string) {
  return andQuery(removeHistoryFilter(query, field), formatTerm(field, value));
}
