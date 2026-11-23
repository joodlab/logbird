// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsTabs } from './settings-tabs';

// The strip only needs links and a router to subscribe to (one router, as the real hook returns).
/** Does nothing: the router unsubscribe. */
const unsubscribe = () => undefined;
const router = { subscribe: () => unsubscribe };
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className, 'aria-current': current }: { children: ReactNode; to: string; className?: string; 'aria-current'?: 'page' }) => (
    <a aria-current={current} className={className} href={to}>
      {children}
    </a>
  ),
  useRouter: () => router,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The ResizeObservers the strip registered, with the elements each observes. */
let observers: FakeResizeObserver[] = [];
class FakeResizeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: () => void) {
    observers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  disconnect() {
    this.targets.clear();
  }
}

/** Resizes one element: only the observers watching it hear about it, as in a browser. */
function resize(target: Element) {
  act(() => {
    for (const observer of observers) if (observer.targets.has(target)) observer.callback();
  });
}

let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  observers = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const TABS = [
  { to: '/general', label: 'General' },
  { to: '/keys', label: 'API keys' },
  { to: '/danger', label: 'Danger zone', danger: true },
] as const;

/**
 * Lays the strip out as a narrowed phone would: a 320px strip holding 400px of tabs, unscrolled. Each tab's viewport rect
 * moves with the strip's scroll, from the left in LTR and from the right in RTL.
 */
function layOut(nav: HTMLElement, rtl: boolean) {
  const spans = [
    [0, 80],
    [80, 200],
    [280, 400],
  ] as const;
  let scrollLeft = 0;
  Object.defineProperty(nav, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (v: number) => {
      scrollLeft = v;
    },
  });
  Object.defineProperty(nav, 'clientWidth', { configurable: true, value: 320 });
  Object.defineProperty(nav, 'scrollWidth', { configurable: true, value: 400 });
  nav.getBoundingClientRect = () => ({ left: 0, right: 320 }) as DOMRect;
  [...nav.children].forEach((tab, i) => {
    const [start, end] = spans[i] ?? [0, 0];
    (tab as HTMLElement).getBoundingClientRect = () =>
      (rtl ? { left: 320 - end - scrollLeft, right: 320 - start - scrollLeft } : { left: start - scrollLeft, right: end - scrollLeft }) as DOMRect;
  });
  return () => scrollLeft;
}

function mount(rtl: boolean) {
  act(() =>
    root?.render(
      <div style={{ direction: rtl ? 'rtl' : 'ltr' }}>
        <SettingsTabs label="Project settings" pathname="/danger" tabs={TABS} />
      </div>,
    ),
  );
  const nav = host.querySelector('nav') as HTMLElement;
  if (rtl) nav.style.direction = 'rtl';
  return nav;
}

it.each([false, true])('brings the current tab back into view and moves the fade when the strip narrows (rtl: %s)', (rtl) => {
  const nav = mount(rtl);
  const scroll = layOut(nav, rtl);
  // The nav keeps its width; its last tab widened (a web font swapped in), so only that tab's observation fires.
  resize(nav.lastElementChild as Element);
  // "Danger zone" ends at 400: scrolled to the 80px maximum, towards the end in either direction.
  expect(scroll()).toBe(rtl ? -80 : 80);
  act(() => {
    nav.dispatchEvent(new Event('scroll'));
  });
  // Scrolled to the end: the fade is at the start only, drawn from the inline start (flipped in RTL).
  expect(nav.style.maskImage).toBe(`linear-gradient(to ${rtl ? 'left' : 'right'}, transparent, #000 28px, #000 calc(100% - 0px), #000)`);
});

it('keeps the focused tab in view before the current one when the strip narrows', () => {
  const nav = mount(false);
  const scroll = layOut(nav, false);
  // Focus "General" without a focusin reveal (the strip is unscrolled, so General is already in view), then scroll away.
  (nav.querySelector('a[href="/general"]') as HTMLElement).focus();
  nav.scrollLeft = 80;
  resize(nav);
  expect(scroll()).toBe(0);
});
