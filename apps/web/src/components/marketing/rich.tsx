import { Fragment } from 'react';
import { THIRD_PARTY_QUOTE_ATTRIBUTE } from '../../lib/source-state';

/**
 * Renders the inline marks the copy files use, `code`, **bold** and *emphasis*, so data modules can keep the wording of
 * marketing/copy/*.md verbatim. Nothing else is parsed: no links, no HTML.
 *
 * `thirdPartyQuotes` is for text about another product only (a comparison's competitor column and its sources): each
 * "double-quoted" passage is a quotation from that product's pages and is marked `data-third-party-quote`, which the
 * source-state check (src/lib/source-state.ts) leaves out. Never set it on text that speaks for Logbird.
 */
export function Rich({ text, thirdPartyQuotes = false }: { text: string; thirdPartyQuotes?: boolean }) {
  if (!thirdPartyQuotes) {
    return <Marks text={text} />;
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
          <Marks key={index} text={part} />
        ),
      )}
    </>
  );
}

function Marks({ text }: { text: string }) {
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
            <strong className="font-semibold text-foreground" key={index}>
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
