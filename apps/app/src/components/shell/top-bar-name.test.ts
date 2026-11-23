import { expect, it } from 'vitest';
import { projectCrumbName } from './top-bar';

const at = (name: string, t: number) => ({ name, at: t });

it('shows a rename read through the detail while the list still has the old name', () => {
  expect(projectCrumbName(at('Alpha', 100), at('Beta', 200))).toBe('Beta');
});

it('keeps the newer list name when a later list refresh fails (a failed refresh keeps its last successful read)', () => {
  // Detail read Alpha at 100; another tab renamed it; the list read Beta at 200; its next refresh failed and kept 200.
  expect(projectCrumbName(at('Beta', 200), at('Alpha', 100))).toBe('Beta');
});

it('never brings back an old list name over a newer detail after the list failed to refresh', () => {
  expect(projectCrumbName(at('Old name', 100), at('New name', 300))).toBe('New name');
});

it('names the project from the detail while the list lacks it, and from the list alone otherwise', () => {
  expect(projectCrumbName(undefined, at('Created in another tab', 100))).toBe('Created in another tab');
  expect(projectCrumbName(at('Only in the list', 100), undefined)).toBe('Only in the list');
  expect(projectCrumbName(undefined, undefined)).toBeUndefined();
});
