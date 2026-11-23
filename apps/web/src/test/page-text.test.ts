import { describe, expect, it } from 'vitest';
import { pageFile, pageText, shellFile } from './page-text';

/**
 * The page-snapshot serializer (page-text.ts) on small documents shaped like the site's: a skip link, a header, <main>
 * and a footer under <body>. Each pair differs in one way a page could change; the page file must tell them apart, and
 * shell lines must stay out of it.
 */
const doc = (body: string) =>
  `<html><head><title>T</title><meta name="description" content="D"/></head><body>${body}<script>ignored()</script></body></html>`;
const SKIP = '<a class="skip-link" href="#main">Skip to content</a>';
const HEADER = '<header><nav><a href="/product">Product</a></nav></header>';
const FOOTER = '<footer><p>Retrace every step.</p><a href="/about">About</a></footer>';
const MAIN = '<main id="main"><h1>Title</h1><p>Body. <a href="/changelog">Read the changelog</a></p></main>';
const page = (body: string) => pageFile(pageText(doc(body)));

describe('page-text serializer', () => {
  it('keeps the page in place and cuts each shell run to one marker', () => {
    const text = pageText(doc(`${SKIP}${HEADER}${MAIN}${FOOTER}`));
    expect(pageFile(text)).toBe(
      [
        'title: T',
        'description: D',
        '',
        'headings:',
        'h1 Title',
        '',
        'text:',
        '[shell: skip link, header — see _shell.txt]',
        'Title',
        'Body. Read the changelog',
        '[shell: footer — see _shell.txt]',
        '',
        'links:',
        '[shell: skip link, header — see _shell.txt]',
        'Read the changelog → /changelog',
        '[shell: footer — see _shell.txt]',
        '',
        'controls:',
        '',
      ].join('\n'),
    );
    expect(shellFile(text)).toBe(
      [
        'headings:',
        '',
        'text:',
        '[region: skip link]',
        'Skip to content',
        '[region: header]',
        'Product',
        '[region: footer]',
        'Retrace every step.',
        'About',
        '',
        'links:',
        '[region: skip link]',
        'Skip to content → #main',
        '[region: header]',
        'Product → /product',
        '[region: footer]',
        'About → /about',
        '',
        'controls:',
        '',
      ].join('\n'),
    );
  });

  it('keeps text written directly under <body>', () => {
    const plain = page(`${SKIP}${HEADER}${MAIN}${FOOTER}`);
    const withSentence = page(`${SKIP}${HEADER}${MAIN}A sentence after main.${FOOTER}`);
    expect(withSentence).not.toBe(plain);
    expect(withSentence).toContain('\nA sentence after main.\n[shell: footer — see _shell.txt]\n');
  });

  it('keeps the order of the regions', () => {
    const footerLast = page(`${SKIP}${HEADER}${MAIN}${FOOTER}`);
    const footerFirst = page(`${SKIP}${HEADER}${FOOTER}${MAIN}`);
    expect(footerFirst).not.toBe(footerLast);
    expect(footerFirst).toContain('text:\n[shell: skip link, header, footer — see _shell.txt]\nTitle\nBody. Read the changelog\n');
    // The shell lines themselves are the same, so only the page file shows the move.
    expect(shellFile(pageText(doc(`${SKIP}${HEADER}${FOOTER}${MAIN}`)))).toBe(shellFile(pageText(doc(`${SKIP}${HEADER}${MAIN}${FOOTER}`))));
  });

  it('reads a top-level image alt, a top-level <pre> and adjacent spans as the full-page walk does', () => {
    const shell = (inner: string) => page(`${SKIP}${HEADER}${MAIN}${inner}${FOOTER}`);
    expect(shell('<img alt="Explorer, dark theme"/>')).toContain('\n[img: Explorer, dark theme]\n');
    expect(shell('<img alt="Explorer, dark theme"/>')).not.toBe(shell('<img alt="Explorer, light theme"/>'));
    expect(shell('<pre>pnpm install\npnpm dev</pre>')).toContain('\npre| pnpm install\npre| pnpm dev\n');
    expect(shell('<pre>pnpm install\npnpm dev</pre>')).not.toBe(shell('<pre>pnpm install pnpm dev</pre>'));
    expect(shell('<span>Free</span><span> trial</span>')).toContain('\nFree trial\n');
    expect(shell('<span>Free</span><span> trial</span>')).not.toBe(shell('<span>Free</span><span>trial</span>'));
  });

  it('never counts a line that mixes shell and other text as shell', () => {
    const text = pageText(doc(`Before ${SKIP}${HEADER}${MAIN}${FOOTER}`));
    expect(pageFile(text)).toContain('text:\nBefore Skip to content\n[shell: header — see _shell.txt]\n');
    expect(shellFile(text)).not.toContain('Skip to content\n');
  });
});
