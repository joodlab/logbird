import { hostOf } from './format';

/**
 * Plain-text parts are written per template from the same props as the HTML (not converted from HTML), so they
 * read like a short note in any client: no preheader filler, no image alts, no "[button]" artifacts.
 */
export type TextBlock =
  | string
  | { code: string; caption?: string }
  | { details: { label: string; value: string; hint?: string }[] }
  | { action: string; url: string }
  | { note: string; title: string };

function renderBlock(block: TextBlock): string {
  if (typeof block === 'string') return block;
  if ('code' in block) return [`    ${block.code}`, block.caption ? `    ${block.caption}` : ''].filter(Boolean).join('\n');
  if ('details' in block) {
    const width = Math.max(...block.details.map((d) => d.label.length)) + 2;
    return block.details
      .flatMap((d) => [`${`${d.label}:`.padEnd(width)}${d.value}`, ...(d.hint ? [`${' '.repeat(width)}${d.hint}`] : [])])
      .join('\n');
  }
  if ('action' in block) return `${block.action}:\n${block.url}`;
  return `${block.title} ${block.note}`;
}

export function plainText({ title, blocks, reason, appUrl }: { title: string; blocks: TextBlock[]; reason: string; appUrl: string }) {
  return [
    title,
    '='.repeat(title.length),
    '',
    blocks.map(renderBlock).join('\n\n'),
    '',
    '--',
    `You received this email because ${reason}`,
    `Trailmark · open-source audit logs · ${hostOf(appUrl)}`,
    appUrl,
    '',
  ].join('\n');
}
