import { WORKSPACE_ACTIVITY_CATEGORIES } from '@logbird/contracts';
import { expect, it } from 'vitest';

it('maps every activity chip to the category of its stored management actions', () => {
  const actions = [
    'project.retention.changed',
    'api_key.created',
    'member.invited',
    'saved_view.created',
    'organization.updated',
    'invite_link.created',
    'auth.signed_out',
  ];
  expect(WORKSPACE_ACTIVITY_CATEGORIES.map(([category]) => category)).toEqual(actions.map((action) => action.split('.')[0]));
  expect(Object.fromEntries(WORKSPACE_ACTIVITY_CATEGORIES)).toMatchObject({ saved_view: 'Views', organization: 'Workspace' });
});
