// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { tabToReveal } from './settings-tabs';

afterEach(() => {
  document.body.innerHTML = '';
});

function strip() {
  const nav = document.createElement('nav');
  nav.innerHTML = '<a href="/general">General</a><a href="/keys">API keys</a><a aria-current="page" href="/danger">Danger zone</a>';
  document.body.append(nav);
  return nav;
}

it('keeps the current section in view after a resize when no tab has focus', () => {
  expect(tabToReveal(strip())?.textContent).toBe('Danger zone');
});

it('keeps the focused tab in view before the current one', () => {
  const nav = strip();
  (nav.querySelector('a[href="/keys"]') as HTMLElement).focus();
  expect(tabToReveal(nav)?.textContent).toBe('API keys');
});

it('ignores focus outside the strip', () => {
  const nav = strip();
  const outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();
  expect(tabToReveal(nav)?.textContent).toBe('Danger zone');
});
