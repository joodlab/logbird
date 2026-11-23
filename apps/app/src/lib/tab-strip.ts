/**
 * Geometry for a horizontally scrolling tab strip, in *logical* coordinates: distances from the strip's inline start
 * (the left edge in LTR, the right edge in RTL). Browsers report `scrollLeft` as 0 at the start and negative towards the
 * end in RTL, so callers convert with `logicalScroll` / `physicalScroll` and never compare raw offsets.
 */

/**
 * The strip's scroll position as a distance from its inline start, clamped to the scrollable range `[0, max]`. The sign
 * is read by direction (positive towards the end in LTR, negative in RTL), so an elastic overscroll past either end (a
 * Safari bounce reporting -20 at an LTR start) clamps to that end instead of reading as a scroll towards the other.
 */
export function logicalScroll(scrollLeft: number, rtl: boolean, max: number): number {
  const logical = rtl ? -scrollLeft : scrollLeft;
  return Math.min(Math.max(0, max), Math.max(0, logical));
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

/**
 * How wide each inline edge's fade is: as wide as the part of the strip hidden behind that edge, up to `fade`, and 0
 * when nothing is. A strip a few pixels too wide (four settings tabs on a 390px phone) gets a fade of those few pixels,
 * never a full fade that dims a tab that is all but whole.
 */
export function stripFades(view: { scroll: number; width: number; scrollWidth: number }, fade: number): { start: number; end: number } {
  const max = Math.max(0, view.scrollWidth - view.width);
  const widthFor = (hidden: number) => (hidden > 1 ? Math.min(fade, Math.round(hidden)) : 0);
  return { start: widthFor(view.scroll), end: widthFor(max - view.scroll) };
}

/** A mask that fades the edges with hidden tabs, each as wide as its fade, drawn from the inline start (so it flips in RTL). */
export function stripMask(fades: { start: number; end: number }, rtl: boolean): string | undefined {
  if (!fades.start && !fades.end) return undefined;
  return `linear-gradient(to ${rtl ? 'left' : 'right'}, ${fades.start ? 'transparent' : '#000'}, #000 ${fades.start}px, #000 calc(100% - ${fades.end}px), ${fades.end ? 'transparent' : '#000'})`;
}
