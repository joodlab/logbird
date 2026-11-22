import { expect, it } from 'vitest';
import { isolationPolicy } from './provision-query-user';

it('#138 phase 2: binds events to the tenant when one is set and hides tenant-less rollups from tenant-bound sessions', () => {
  expect(isolationPolicy('events')).toBe(
    "project_id = getSetting('SQL_logbird_project') AND (getSetting('SQL_logbird_tenant') = '' OR tenant_id = getSetting('SQL_logbird_tenant'))",
  );
  for (const table of ['events_by_minute', 'entities', 'attribute_keys'])
    expect(isolationPolicy(table)).toBe("project_id = getSetting('SQL_logbird_project') AND getSetting('SQL_logbird_tenant') = ''");
});
