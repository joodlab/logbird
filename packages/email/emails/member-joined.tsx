// react-email preview entry (`pnpm --filter @trailmark/email dev`). Sample data lives in src/fixtures.ts.
import * as React from 'react';
import { fixtures } from '../src/fixtures';
import { MemberJoinedEmail } from '../src/templates/member-joined';

const Preview = () => <MemberJoinedEmail {...fixtures.memberJoined} />;
export default Preview;
