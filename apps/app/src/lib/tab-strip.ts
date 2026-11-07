/**
 * Geometry for a horizontally scrolling tab strip, in *logical* coordinates: distances from the strip's inline start
 * (the left edge in LTR, the right edge in RTL). Browsers report `scrollLeft` as 0 at the start and negative towards the
 * end in RTL, so callers convert with `logicalScroll` / `physicalScroll` and never compare raw offsets.
 */

/** The strip's scroll position as a distance from its inline start (≥ 0 in both directions). */
export function logicalScroll(scrollLeft: number): number {
  return Math.abs(scrollLeft);
}

/** The `scrollLeft` value for a logical scroll position. */
export function physicalScroll(logical: number, rtl: boolean): number {
  return rtl ? -logical : logical;
}

/** Where a tab sits inside the strip's scrolled content, from its inline start, given both elements' viewport rects. */
export function logicalTabSpan(
  strip: { left: number; right: number },
  tab: { left: number; right: number },
  scroll: number,
  rtl: boolean,
): { start: number; end: number } {
  const start = (rtl ? strip.right - tab.right : tab.left - strip.left) + scroll;
  return { start, end: start + (tab.right - tab.left) };
}

/**
 * The logical scroll position that brings a tab fully into view, clear of the `fade` at each edge; null when it already
 * is. Clamped to the scrollable range.
 */
export function revealScroll(
  tab: { start: number; end: number },
  view: { scroll: number; width: number; scrollWidth: number },
  fade: number,
): number | null {
  const max = Math.max(0, view.scrollWidth - view.width);
  let target: number | null = null;
  if (tab.start - fade < view.scroll) target = tab.start - fade;
  else if (tab.end + fade > view.scroll + view.width) target = tab.end + fade - view.width;
  return target === null ? null : Math.min(max, Math.max(0, target));
}

/** Which inline edges have tabs scrolled out behind them. */
export function stripEdges(view: { scroll: number; width: number; scrollWidth: number }): { start: boolean; end: boolean } {
  const max = view.scrollWidth - view.width;
  return { start: view.scroll > 1, end: max - view.scroll > 1 };
}

/** A mask that fades the edges with hidden tabs, drawn from the inline start (so it flips in RTL). */
export function stripMask(edges: { start: boolean; end: boolean }, fade: number, rtl: boolean): string | undefined {
  if (!edges.start && !edges.end) return undefined;
  return `linear-gradient(to ${rtl ? 'left' : 'right'}, ${edges.start ? 'transparent' : '#000'}, #000 ${fade}px, #000 calc(100% - ${fade}px), ${edges.end ? 'transparent' : '#000'})`;
}
