// react-email preview entry (`pnpm --filter @trailmark/email dev`). Sample data lives in src/fixtures.ts.
import * as React from 'react';
import { fixtures } from '../src/fixtures';
import { SignInCodeEmail } from '../src/templates/sign-in-code';

const Preview = () => <SignInCodeEmail {...fixtures.signInCode} />;
export default Preview;
