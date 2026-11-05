// The server runs these through tsx with the classic JSX runtime, so React must be in scope.
import * as React from 'react';
import { Heading, Text } from 'react-email';
import { colors, EmailLayout, fonts } from './layout';

export function SignInCodeEmail({ code }: { code: string }) {
  return (
    <EmailLayout footnote="If you did not try to sign in, you can ignore this email." preview="Your Trailmark sign-in code">
      <Heading style={{ fontSize: '22px', lineHeight: '30px', margin: '0 0 8px' }}>Your sign-in code</Heading>
      <Text style={{ color: colors.muted, fontSize: '15px', lineHeight: '24px', margin: '0 0 20px' }}>
        Enter this code to sign in. It expires in 10 minutes.
      </Text>
      <Text
        style={{
          fontFamily: fonts.mono,
          fontSize: '36px',
          letterSpacing: '10px',
          padding: '20px 0',
          margin: 0,
          textAlign: 'center',
          backgroundColor: colors.tint,
          border: `1px solid ${colors.border}`,
          borderRadius: '8px',
        }}
      >
        {code}
      </Text>
    </EmailLayout>
  );
}
