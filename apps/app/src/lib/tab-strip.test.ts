import { describe, expect, it } from 'vitest';
import { logicalScroll, logicalTabSpan, physicalScroll, revealScroll, stripEdges, stripMask } from './tab-strip';

/** A 390px phone strip holding 600px of tabs: the viewport rect of the strip and its tabs. */
const strip = { left: 16, right: 374 };
const width = strip.right - strip.left;
const scrollWidth = 600;
const FADE = 28;

describe('tab strip geometry', () => {
  it('converts scrollLeft to a distance from the inline start and back, in both directions', () => {
    expect(logicalScroll(120)).toBe(120);
    expect(logicalScroll(-120)).toBe(120);
    expect(physicalScroll(120, false)).toBe(120);
    expect(physicalScroll(120, true)).toBe(-120);
  });

  it('measures a tab from the left in LTR and from the right in RTL', () => {
    // LTR, unscrolled: a tab 300px into the strip.
    expect(logicalTabSpan(strip, { left: 316, right: 400 }, 0, false)).toEqual({ start: 300, end: 384 });
    // RTL, unscrolled: the same tab 300px from the strip's right-hand start sits at right = 374 - 300.
    expect(logicalTabSpan(strip, { left: -10, right: 74 }, 0, true)).toEqual({ start: 300, end: 384 });
    // RTL, scrolled 100px towards the end: the tab moved 100px right on screen, its logical span did not change.
    expect(logicalTabSpan(strip, { left: 90, right: 174 }, 100, true)).toEqual({ start: 300, end: 384 });
  });

  it('reveals an offscreen tab clear of the fades, and the first tab by scrolling back to the start', () => {
    const view = { scroll: 0, width, scrollWidth };
    // "Danger zone" at the end: scroll so its end clears the end fade (clamped to the maximum).
    expect(revealScroll({ start: 500, end: 600 }, view, FADE)).toBe(scrollWidth - width);
    // Back to "General" from the end.
    expect(revealScroll({ start: 0, end: 70 }, { ...view, scroll: scrollWidth - width }, FADE)).toBe(0);
    // Already visible: leave the strip alone.
    expect(revealScroll({ start: 100, end: 180 }, view, FADE)).toBeNull();
  });

  it('reports hidden edges logically and flips the fade in RTL', () => {
    expect(stripEdges({ scroll: 0, width, scrollWidth })).toEqual({ start: false, end: true });
    expect(stripEdges({ scroll: scrollWidth - width, width, scrollWidth })).toEqual({ start: true, end: false });
    expect(stripMask({ start: false, end: false }, FADE, false)).toBeUndefined();
    expect(stripMask({ start: false, end: true }, FADE, false)).toMatch(/^linear-gradient\(to right, #000,.*transparent\)$/);
    expect(stripMask({ start: false, end: true }, FADE, true)).toMatch(/^linear-gradient\(to left, #000,.*transparent\)$/);
  });
});
