import { Fragment } from 'react';
import { THIRD_PARTY_QUOTE_ATTRIBUTE } from '../../lib/source-state';

/**
 * Renders the inline marks the content modules (src/content/) use in their wording: `code`, **bold** and *emphasis*.
 * Nothing else is parsed: no links, no HTML.
 *
 * `thirdPartyQuotes` is for text about another product only (a comparison's competitor column and its sources): each
 * "double-quoted" passage is a quotation from that product's pages and is marked `data-third-party-quote`, which the
 * source-state check (src/lib/source-state.ts) leaves out. Never set it on text that speaks for Logbird.
 *
 * `strongClassName` styles **bold**, for pages whose lead-ins use a lighter weight than the default.
 */
export function Rich({
  text,
  thirdPartyQuotes = false,
  strongClassName = DEFAULT_STRONG,
}: {
  text: string;
  thirdPartyQuotes?: boolean;
  strongClassName?: string;
}) {
  if (!thirdPartyQuotes) {
    return <Marks strongClassName={strongClassName} text={text} />;
  }
  const parts = text.split(/("[^"\n]+")/g);
  return (
    <>
      {parts.map((part, index) =>
        part.length > 2 && part.startsWith('"') && part.endsWith('"') ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
          <span key={index} {...{ [THIRD_PARTY_QUOTE_ATTRIBUTE]: '' }}>
            {part}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
          <Marks key={index} strongClassName={strongClassName} text={part} />
        ),
      )}
    </>
  );
}

const DEFAULT_STRONG = 'font-semibold text-foreground';

function Marks({ text, strongClassName }: { text: string; strongClassName: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
          return <code key={index}>{part.slice(1, -1)}</code>;
        }
        if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
            <strong className={strongClassName} key={index}>
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
          return <em key={index}>{part.slice(1, -1)}</em>;
        }
        // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}
