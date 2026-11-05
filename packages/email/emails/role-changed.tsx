// react-email preview entry (`pnpm --filter @trailmark/email dev`). Sample data lives in src/fixtures.ts.
import * as React from 'react';
import { fixtures } from '../src/fixtures';
import { RoleChangedEmail } from '../src/templates/role-changed';

const Preview = () => <RoleChangedEmail {...fixtures.roleChanged} />;
export default Preview;
