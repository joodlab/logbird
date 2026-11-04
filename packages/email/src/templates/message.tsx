import * as React from 'react';
import { Body, Container, Head, Heading, Html, Link, Preview, Text } from 'react-email';
export function Message({ code, organization, url }: { code?: string; organization?: string; url?: string }) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{code ? 'Your Trailmark sign-in code' : `Join ${organization} on Trailmark`}</Preview>
      <Body style={{ backgroundColor: '#f5f5f4', fontFamily: 'Geist, Inter, Arial, sans-serif', color: '#202020', padding: '48px 12px' }}>
        <Container style={{ backgroundColor: '#fff', padding: '40px', border: '1px solid #e7e5e4', borderRadius: '12px', maxWidth: '480px' }}>
          <Text style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-1px' }}>Trailmark</Text>
          <Heading style={{ fontSize: '24px', marginTop: '36px' }}>{code ? 'Your sign-in code' : 'Your team is waiting'}</Heading>
          <Text style={{ color: '#57534e', lineHeight: '26px' }}>
            {code ? 'Enter this code to sign in. It expires in 10 minutes.' : `You have been invited to join ${organization} on Trailmark.`}
          </Text>
          {code ? (
            <Text
              style={{
                fontFamily: 'Geist Mono, Consolas, monospace',
                fontSize: '40px',
                letterSpacing: '10px',
                padding: '24px 0',
                textAlign: 'center',
                backgroundColor: '#fafaf9',
                borderRadius: '8px',
              }}
            >
              {code}
            </Text>
          ) : (
            <Link
              href={url}
              style={{ display: 'inline-block', backgroundColor: '#202020', color: '#fff', padding: '14px 22px', borderRadius: '6px' }}
            >
              Accept invitation
            </Link>
          )}
          <Text style={{ fontSize: '13px', color: '#78716c', marginTop: '32px' }}>If you did not request this email, you can ignore it.</Text>
          <Text style={{ fontSize: '12px', color: '#a8a29e', borderTop: '1px solid #e7e5e4', paddingTop: '20px' }}>
            Trailmark - A clear history of what happened.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
