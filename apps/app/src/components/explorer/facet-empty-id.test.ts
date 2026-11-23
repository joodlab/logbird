import { parseQueryExpression } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import { toggleTerm } from '@/lib/query-language';
import { facetValueLabel } from './facet-sidebar';

describe('empty-id facet bucket (#333)', () => {
  it('reads "No actor ID" / "No executor ID", never the last name the bucket saw', () => {
    expect(facetValueLabel('actor', '', 'Front desk')).toEqual({ text: 'No actor ID', placeholder: true });
    expect(facetValueLabel('executor', '', 'Billing worker')).toEqual({ text: 'No executor ID', placeholder: true });
    expect(facetValueLabel('actor', 'usr_1', 'Lina')).toEqual({ text: 'Lina', placeholder: false });
    expect(facetValueLabel('tenant', '', '')).toEqual({ text: '(none)', placeholder: true });
  });

  it('filters with field:"" — one exact term for the empty value, the same rows the bucket counted', () => {
    for (const field of ['actor', 'executor']) {
      const q = toggleTerm('', field, '', 'include');
      expect(q).toBe(`${field}:""`);
      const atom = parseQueryExpression(q)[0]?.[0]?.atom;
      expect(atom).toMatchObject({ kind: 'field', field, value: { kind: 'value', token: { value: '', wildcard: false } } });
      // Clicking again removes it; alt-click excludes it.
      expect(toggleTerm(q, field, '', 'include')).toBe('');
      expect(toggleTerm('', field, '', 'exclude')).toBe(`-${field}:""`);
    }
  });
});
