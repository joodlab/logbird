// react-email preview entry (`pnpm --filter @trailmark/email dev`). Sample data lives in src/fixtures.ts.
import * as React from 'react';
import { fixtures } from '../src/fixtures';
import { InvitationEmail } from '../src/templates/invitation';

const Preview = () => <InvitationEmail {...fixtures.invitation} />;
export default Preview;
