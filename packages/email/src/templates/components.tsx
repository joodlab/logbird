// biome-ignore-all lint/suspicious/noArrayIndexKey: Fixed bird pixel coordinates never reorder.
// The server runs these through tsx with the classic JSX runtime, so React must be in scope.
import * as React from 'react';
import { Head, Html, Preview } from 'react-email';
import { hostOf } from '../format';
import { baseCss, CONTAINER_WIDTH, cx, darkCss, fonts, light, outlookDarkCss, type } from './theme';

/** Every layout table: no borders, no spacing, and hidden from screen readers' table navigation. */
const table = { role: 'presentation', border: 0, cellPadding: 0, cellSpacing: 0 } as const;

const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** Outlook (Windows) DPI fix; React cannot emit conditional comments in <head>, so render.ts injects it. */
export const MSO_HEAD =
  '<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->';

/** Namespaces for the VML button (Outlook on Windows). Not in React's <html> typings, hence the spread. */
const OFFICE_NAMESPACES = {
  xmlns: 'http://www.w3.org/1999/xhtml',
  'xmlns:v': 'urn:schemas-microsoft-com:vml',
  'xmlns:o': 'urn:schemas-microsoft-com:office:office',
} as Record<string, string>;

export interface EmailLayoutProps {
  /** Inbox preheader: the line shown after the subject. */
  preview: string;
  /** Short title for the document <title> (some clients and screen readers show it). */
  title: string;
  /** Why this person received the email, completing "You received this email because …". */
  reason: string;
  /** Public URL of this Logbird install. */
  appUrl: string;
  children: React.ReactNode;
}

/** Wordmark: an HTML table bird mark that survives image blocking. */
function EmailBird() {
  const rows = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 2, 2, 2, 2, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ];
  return (
    <table {...table} aria-hidden style={{ width: '26px', height: '26px', borderCollapse: 'collapse' }}>
      <tbody>
        {rows.map((row, y) => (
          <tr key={y}>
            {row.map((pixel, x) => (
              <td
                key={x}
                style={{
                  width: '1.625px',
                  height: '1.625px',
                  padding: 0,
                  fontSize: 0,
                  lineHeight: 0,
                  backgroundColor: pixel === 2 ? '#818cf8' : pixel === 1 ? light.markText : light.mark,
                }}
              />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Wordmark({ appUrl }: { appUrl: string }) {
  return (
    <a href={appUrl} style={{ textDecoration: 'none', color: light.text }}>
      <table {...table}>
        <tbody>
          <tr>
            <td
              align="center"
              className={cx.mark}
              height={26}
              style={{
                width: '26px',
                height: '26px',
                backgroundColor: light.mark,
                color: light.markText,
                borderRadius: '7px',
                fontFamily: fonts.sans,
                fontSize: '15px',
                lineHeight: '26px',
                fontWeight: 700,
                textAlign: 'center',
                verticalAlign: 'middle',
              }}
              width={26}
            >
              <EmailBird />
            </td>
            <td
              className={cx.text}
              style={{
                paddingLeft: '9px',
                fontFamily: fonts.sans,
                fontSize: '16px',
                lineHeight: '26px',
                fontWeight: 600,
                letterSpacing: '-0.3px',
                color: light.text,
              }}
            >
              logbird
            </td>
          </tr>
        </tbody>
      </table>
    </a>
  );
}

/** Shared chrome: preheader, wordmark, content card and a footer that says why the email was sent. */
export function EmailLayout({ preview, title, reason, appUrl, children }: EmailLayoutProps) {
  return (
    <Html dir="ltr" lang="en" {...OFFICE_NAMESPACES}>
      <Head>
        <meta content="width=device-width, initial-scale=1" name="viewport" />
        <meta content="light dark" name="color-scheme" />
        <meta content="light dark" name="supported-color-schemes" />
        <meta content="telephone=no, date=no, address=no, email=no, url=no" name="format-detection" />
        <title>{title}</title>
        <style>{baseCss}</style>
        <style>{darkCss}</style>
        <style>{outlookDarkCss}</style>
      </Head>
      <body className={cx.page} style={{ margin: 0, padding: 0, width: '100%', backgroundColor: light.page }}>
        <Preview useTitleTag={false}>{preview}</Preview>
        <table {...table} className={cx.page} style={{ width: '100%', backgroundColor: light.page }} width="100%">
          <tbody>
            <tr>
              <td align="center" className={cx.shell} style={{ padding: '40px 16px 48px' }}>
                <table {...table} style={{ width: '100%', maxWidth: `${CONTAINER_WIDTH}px` }} width="100%">
                  <tbody>
                    <tr>
                      <td style={{ padding: '0 4px 20px' }}>
                        <Wordmark appUrl={appUrl} />
                      </td>
                    </tr>
                    <tr>
                      <td
                        className={cx.card}
                        style={{
                          backgroundColor: light.card,
                          border: `1px solid ${light.border}`,
                          borderRadius: '12px',
                          padding: '36px 40px 32px',
                          fontFamily: fonts.sans,
                          color: light.text,
                        }}
                      >
                        {children}
                      </td>
                    </tr>
                    <tr>
                      <td className={cx.faint} style={{ padding: '24px 4px 0', fontFamily: fonts.sans, ...type.tiny, color: light.faint }}>
                        You received this email because {reason}
                        <br />
                        <br />
                        <a className={cx.faint} href={appUrl} style={{ color: light.faint, textDecoration: 'underline' }}>
                          Logbird
                        </a>{' '}
                        · open-source audit logs · {hostOf(appUrl)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </Html>
  );
}

export function Title({ children }: { children: React.ReactNode }) {
  return (
    <h1 className={cx.h1} style={{ margin: '0 0 12px', fontFamily: fonts.sans, color: light.text, ...type.h1 }}>
      {children}
    </h1>
  );
}

export function Paragraph({
  children,
  tone = 'muted',
  size = 'body',
  spacing = 16,
}: {
  children: React.ReactNode;
  tone?: 'text' | 'muted' | 'faint';
  size?: 'body' | 'small';
  spacing?: number;
}) {
  return (
    <p className={cx[tone]} style={{ margin: `0 0 ${spacing}px`, fontFamily: fonts.sans, color: light[tone], ...type[size] }}>
      {children}
    </p>
  );
}

/** Emphasis inside muted copy: names, workspaces, roles. */
export function Strong({ children }: { children: React.ReactNode }) {
  return (
    <strong className={cx.text} style={{ color: light.text, fontWeight: 600 }}>
      {children}
    </strong>
  );
}

export function TextLink({ href, children, mono = false }: { href: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <a
      className={cx.link}
      href={href}
      style={{
        color: light.link,
        textDecoration: 'underline',
        wordBreak: 'break-all',
        ...(mono ? { fontFamily: fonts.mono, fontSize: '12px', lineHeight: '18px' } : {}),
      }}
    >
      {children}
    </a>
  );
}

export function Spacer({ height }: { height: number }) {
  return (
    <table {...table} style={{ width: '100%' }} width="100%">
      <tbody>
        <tr>
          <td height={height} style={{ height: `${height}px`, fontSize: '1px', lineHeight: `${height}px` }}>
            &nbsp;
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function Divider({ spacing = 24 }: { spacing?: number }) {
  return (
    <table {...table} style={{ width: '100%', margin: `${spacing}px 0` }} width="100%">
      <tbody>
        <tr>
          <td className={cx.divider} style={{ borderTop: `1px solid ${light.divider}`, fontSize: '1px', lineHeight: '1px', height: '1px' }}>
            &nbsp;
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * Bulletproof button: a padded <a> (every client, whole area clickable) inside a colored cell, plus a VML
 * roundrect for Outlook on Windows, which ignores padding and border-radius on links.
 */
export function Button({ href, children }: { href: string; children: string }) {
  const width = Math.max(160, Math.round(children.length * 8.6 + 48));
  const font = `font-family:${fonts.sans};font-size:15px;font-weight:600;`;
  const vml = `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${escapeHtml(href)}" style="height:44px;v-text-anchor:middle;width:${width}px;" arcsize="18%" stroke="f" fillcolor="${light.button}"><w:anchorlock/><center style="color:${light.buttonText};font-family:Arial,sans-serif;font-size:15px;font-weight:600;">${escapeHtml(children)}</center></v:roundrect><![endif]-->`;
  const link = `<!--[if !mso]><!--><a class="${cx.buttonLink}" href="${escapeHtml(href)}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 22px;${font}line-height:20px;color:${light.buttonText};background-color:${light.button};text-decoration:none;border-radius:8px;mso-hide:all;">${escapeHtml(children)}</a><!--<![endif]-->`;
  return (
    <table {...table}>
      <tbody>
        <tr>
          <td
            className={cx.button}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: Outlook's conditional comments can only be emitted as raw HTML; every interpolated value is escaped.
            dangerouslySetInnerHTML={{ __html: vml + link }}
            style={{ backgroundColor: light.button, borderRadius: '8px' }}
          />
        </tr>
      </tbody>
    </table>
  );
}

/** One-time code: large, monospaced, selectable in one tap, with an optional caption under it. */
export function CodeBlock({ code, caption }: { code: string; caption?: string }) {
  return (
    <table {...table} style={{ width: '100%' }} width="100%">
      <tbody>
        <tr>
          <td
            align="center"
            className={cx.well}
            style={{
              backgroundColor: light.well,
              border: `1px solid ${light.wellBorder}`,
              borderRadius: '10px',
              padding: '22px 16px 18px',
              textAlign: 'center',
            }}
          >
            <p
              className={cx.code}
              style={{
                margin: 0,
                // Letter-spacing also trails the last digit; pad the left by the same amount to stay centered.
                paddingLeft: '10px',
                fontFamily: fonts.mono,
                fontSize: '34px',
                lineHeight: '40px',
                fontWeight: 600,
                letterSpacing: '10px',
                color: light.text,
              }}
            >
              {code}
            </p>
            {caption ? (
              <p className={cx.faint} style={{ margin: '10px 0 0', fontFamily: fonts.sans, ...type.small, color: light.faint }}>
                {caption}
              </p>
            ) : null}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export interface Detail {
  label: string;
  value: React.ReactNode;
  /** Secondary line under the value (e.g. what a role means). */
  hint?: string;
  mono?: boolean;
}

/** Key-value rows for the facts an operator wants to scan: who, what, when, from where. */
export function DetailRows({ rows }: { rows: Detail[] }) {
  return (
    <table {...table} style={{ width: '100%' }} width="100%">
      <tbody>
        {rows.map((row, index) => (
          <tr key={row.label}>
            <td
              className={`${cx.label} ${cx.divider}`}
              style={{
                width: '128px',
                padding: '10px 12px 10px 0',
                borderTop: index === 0 ? 'none' : `1px solid ${light.divider}`,
                verticalAlign: 'top',
                fontFamily: fonts.sans,
                ...type.small,
                color: light.faint,
              }}
              valign="top"
              width={128}
            >
              {row.label}
            </td>
            <td
              className={`${cx.text} ${cx.divider}`}
              style={{
                padding: '10px 0',
                borderTop: index === 0 ? 'none' : `1px solid ${light.divider}`,
                verticalAlign: 'top',
                fontFamily: row.mono ? fonts.mono : fonts.sans,
                ...type.small,
                fontWeight: 500,
                color: light.text,
                wordBreak: 'break-word',
              }}
              valign="top"
            >
              {row.value}
              {row.hint ? (
                <span className={cx.muted} style={{ display: 'block', fontFamily: fonts.sans, fontWeight: 400, color: light.muted }}>
                  {row.hint}
                </span>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Quiet closing note ("Didn't request this?"), separated from the main content by a hairline. */
export function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <Divider spacing={24} />
      <p className={cx.muted} style={{ margin: 0, fontFamily: fonts.sans, ...type.small, color: light.muted }}>
        <Strong>{title}</Strong> {children}
      </p>
    </>
  );
}

/** "Button not working?" fallback with the raw URL, always visible so it can be copied. */
export function RawLink({ href, label = 'Or paste this link into your browser:' }: { href: string; label?: string }) {
  return (
    <p className={cx.faint} style={{ margin: '16px 0 0', fontFamily: fonts.sans, ...type.tiny, color: light.faint }}>
      {label}
      <br />
      <TextLink href={href} mono>
        {href}
      </TextLink>
    </p>
  );
}
