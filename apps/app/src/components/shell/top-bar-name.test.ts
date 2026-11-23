import { expect, it } from 'vitest';
import { projectCrumbName } from './top-bar';

it('names the project from a healthy list, even when a slower, older detail response arrives last', () => {
  expect(projectCrumbName('New name', 'success', 'Old name')).toBe('New name');
});

it('names it from the cached detail once the list failed its last refresh (its entry is stale)', () => {
  expect(projectCrumbName('Old name', 'error', 'New name')).toBe('New name');
});

it('names it from the detail while the list lacks the project, and falls back to the list entry', () => {
  expect(projectCrumbName(undefined, 'success', 'Created in another tab')).toBe('Created in another tab');
  expect(projectCrumbName('Only in the list', 'error', undefined)).toBe('Only in the list');
  expect(projectCrumbName(undefined, 'pending', undefined)).toBeUndefined();
});
