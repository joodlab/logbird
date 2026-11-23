import { describe, expect, it } from 'vitest';
import { logicalScroll, logicalTabSpan, physicalScroll, revealScroll, stripFades, stripMask } from './tab-strip';

/** A 390px phone strip holding 600px of tabs: the viewport rect of the strip and its tabs. */
const strip = { left: 16, right: 374 };
const width = strip.right - strip.left;
const scrollWidth = 600;
const FADE = 28;

describe('tab strip geometry', () => {
  it('converts scrollLeft to a distance from the inline start and back, in both directions', () => {
    expect(logicalScroll(120, false, 242)).toBe(120);
    expect(logicalScroll(-120, true, 242)).toBe(120);
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

  it('fades the edges with hidden tabs, logically, and flips the fade in RTL', () => {
    expect(stripFades({ scroll: 0, width, scrollWidth }, FADE)).toEqual({ start: 0, end: FADE });
    expect(stripFades({ scroll: scrollWidth - width, width, scrollWidth }, FADE)).toEqual({ start: FADE, end: 0 });
    expect(stripMask({ start: 0, end: 0 }, false)).toBeUndefined();
    expect(stripMask({ start: 0, end: FADE }, false)).toBe(`linear-gradient(to right, #000, #000 0px, #000 calc(100% - ${FADE}px), transparent)`);
    expect(stripMask({ start: 0, end: FADE }, true)).toMatch(/^linear-gradient\(to left, #000,.*transparent\)$/);
  });

  it('fades only as much as is hidden: a strip 3px too wide never dims a tab that is all but whole', () => {
    // Four settings tabs on a 390px phone: 361px of tabs in a 358px strip.
    expect(stripFades({ scroll: 0, width: 358, scrollWidth: 361 }, FADE)).toEqual({ start: 0, end: 3 });
    expect(stripFades({ scroll: 3, width: 358, scrollWidth: 361 }, FADE)).toEqual({ start: 3, end: 0 });
    // A pixel of rounding is not a hidden tab.
    expect(stripFades({ scroll: 0, width: 358, scrollWidth: 359 }, FADE)).toEqual({ start: 0, end: 0 });
    expect(stripMask({ start: 0, end: 3 }, false)).toBe('linear-gradient(to right, #000, #000 0px, #000 calc(100% - 3px), transparent)');
  });

  it('clamps an elastic overscroll to the end it went past, in both directions', () => {
    // 3px of overflow: 361px of tabs in a 358px strip.
    const max = 3;
    // LTR: a bounce past the start reports a negative offset, past the end more than the maximum.
    expect(logicalScroll(-20, false, max)).toBe(0);
    expect(logicalScroll(23, false, max)).toBe(max);
    // RTL: the start is 0 and the end negative, so a bounce past the start is positive.
    expect(logicalScroll(20, true, max)).toBe(0);
    expect(logicalScroll(-23, true, max)).toBe(max);
    // So the fades stay where the hidden pixels are: none at the start, the 3px at the end.
    expect(stripFades({ scroll: logicalScroll(-20, false, max), width: 358, scrollWidth: 361 }, FADE)).toEqual({ start: 0, end: 3 });
    expect(stripFades({ scroll: logicalScroll(-23, true, max), width: 358, scrollWidth: 361 }, FADE)).toEqual({ start: 3, end: 0 });
    // Nothing to scroll: always 0.
    expect(logicalScroll(5, false, 0)).toBe(0);
  });
});
