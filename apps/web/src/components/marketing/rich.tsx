import { Fragment } from 'react';

/**
 * Renders the inline marks the copy files use, `code`, **bold** and *emphasis*, so data modules can keep the wording of
 * marketing/copy/*.md verbatim. Nothing else is parsed: no links, no HTML.
 */
export function Rich({ text }: { text: string }) {
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
