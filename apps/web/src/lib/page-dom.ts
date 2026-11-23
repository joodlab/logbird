/**
 * A small, dependency-free reader for the HTML React renders on the server (well-formed: every element closed, void
 * elements known), for the live asset check (live-assets.ts, check:live). It builds an element
 * tree and gives each element's visible text, with a space wherever a block element starts or ends.
 */
export interface PageElement {
  tag: string;
  attrs: Record<string, string>;
  children: (PageElement | string)[];
  parent?: PageElement;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);
/** Elements that stay inside a sentence; every other element is a block boundary. */
const INLINE = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'button',
  'cite',
  'code',
  'data',
  'dfn',
  'em',
  'i',
  'kbd',
  'mark',
  'q',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
]);

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decode = (text: string) =>
  text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED[entity.toLowerCase()] ?? match;
  });

/** The element tree of `html`; raw-text elements (scripts, styles) keep no children. */
export function parsePage(html: string): PageElement {
  const root: PageElement = { tag: '#root', attrs: {}, children: [] };
  const stack: PageElement[] = [root];
  const token =
    /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  for (let match = token.exec(html); match; match = token.exec(html)) {
    const [, close, open, attributes = '', selfClosing, text] = match;
    const top = stack.at(-1) as PageElement;
    if (text !== undefined) {
      top.children.push(decode(text));
    } else if (close) {
      const tag = close.toLowerCase();
      const at = stack.map((element) => element.tag).lastIndexOf(tag);
      if (at > 0) {
        stack.length = at;
      }
    } else if (open) {
      const tag = open.toLowerCase();
      const attrs: Record<string, string> = {};
      for (const [, name = '', , double, single, bare] of attributes.matchAll(/([^\s=>/]+)(\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attrs[name.toLowerCase()] = decode(double ?? single ?? bare ?? '');
      }
      const element: PageElement = { tag, attrs, children: [], parent: top };
      top.children.push(element);
      if (RAW.has(tag)) {
        const end = html.toLowerCase().indexOf(`</${tag}`, token.lastIndex);
        token.lastIndex = end < 0 ? html.length : end;
      } else if (!VOID.has(tag) && !selfClosing) {
        stack.push(element);
      }
    }
  }
  return root;
}

/**
 * Text a sighted reader doesn't see as written: screen-reader-only prefixes (`sr-only`) and responsive duplicates
 * hidden from some width up (`md:hidden`), which repeat content the page shows in another element at that width.
 */
export const duplicate = (element: PageElement) =>
  element.attrs['aria-hidden'] === 'true' ||
  (element.attrs.class ?? '').split(/\s+/).some((token) => token === 'sr-only' || /^(sm|md|lg|xl|2xl):hidden$/.test(token));

/** Whether an element starts a new line of text: a block tag, or an inline tag styled as a block (`block`, `flex`). */
export const isBlock = (element: PageElement) =>
  !INLINE.has(element.tag) || (element.attrs.class ?? '').split(/\s+/).some((token) => /^(block|flex|grid|table)$/.test(token));

/** Visible text of a node, with a space at each block boundary (not normalized). */
export function textOf(node: PageElement | string): string {
  if (typeof node === 'string') {
    return node;
  }
  if (RAW.has(node.tag) || node.tag === 'svg' || node.tag === 'template' || duplicate(node)) {
    return '';
  }
  const inner = node.children.map(textOf).join('');
  return isBlock(node) ? ` ${inner} ` : inner;
}

/** Every element below `root`, in document order. */
export function* elements(root: PageElement): Generator<PageElement> {
  for (const child of root.children) {
    if (typeof child !== 'string') {
      yield child;
      yield* elements(child);
    }
  }
}

export const elementChildren = (element: PageElement) => element.children.filter((child): child is PageElement => typeof child !== 'string');

/** The runs of inline text inside an element, split at each block child (text, then a block, then more text). */
export function inlineRuns(element: PageElement): string[] {
  const runs: string[] = [];
  let current = '';
  for (const child of element.children) {
    if (typeof child !== 'string' && isBlock(child)) {
      runs.push(current);
      current = '';
    } else {
      current += textOf(child);
    }
  }
  runs.push(current);
  return runs;
}
