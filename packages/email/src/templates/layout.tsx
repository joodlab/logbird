// The server runs these through tsx with the classic JSX runtime, so React must be in scope.
import * as React from 'react';
import { Body, Container, Head, Html, Preview, Section, Text } from 'react-email';

export const colors = {
  page: '#f5f5f4',
  card: '#ffffff',
  border: '#e7e5e4',
  text: '#1c1917',
  muted: '#57534e',
  subtle: '#78716c',
  faint: '#a8a29e',
  tint: '#fafaf9',
  brand: '#1c1917',
};
export const fonts = { sans: 'Geist, Inter, -apple-system, Segoe UI, Arial, sans-serif', mono: 'Geist Mono, SFMono-Regular, Consolas, monospace' };

/** Shared chrome for every Trailmark email: brand row, white card, quiet footer. */
export function EmailLayout({ preview, children, footnote }: { preview: string; children: React.ReactNode; footnote: string }) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: colors.page, fontFamily: fonts.sans, color: colors.text, margin: 0, padding: '40px 12px' }}>
        <Container style={{ maxWidth: '480px' }}>
          <Text style={{ fontSize: '18px', fontWeight: 700, letterSpacing: '-0.5px', margin: '0 0 16px 4px' }}>
            <span
              style={{
                display: 'inline-block',
                width: '10px',
                height: '10px',
                borderRadius: '3px',
                backgroundColor: colors.brand,
                marginRight: '8px',
              }}
            />
            Trailmark
          </Text>
          <Section style={{ backgroundColor: colors.card, padding: '36px 36px 28px', border: `1px solid ${colors.border}`, borderRadius: '12px' }}>
            {children}
            <Text style={{ fontSize: '13px', lineHeight: '20px', color: colors.subtle, margin: '28px 0 0' }}>{footnote}</Text>
          </Section>
          <Text style={{ fontSize: '12px', color: colors.faint, margin: '20px 4px 0' }}>Trailmark · A clear history of what happened.</Text>
        </Container>
      </Body>
    </Html>
  );
}
