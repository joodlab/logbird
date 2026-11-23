// @vitest-environment happy-dom
import type { WebhookEndpoint } from '@logbird/contracts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { EndpointStates } from './endpoint-states';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;

const endpoint = (filterWarning: WebhookEndpoint['filterWarning']) =>
  ({ id: 'qa-endpoint-1', url: 'https://example.com/qa-hook', enabled: true, filterQuery: 'action:/(?=x)/', filterWarning }) as WebhookEndpoint;

function render(e: WebhookEndpoint, confirming = false) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const onConfirmFilter = vi.fn();
  const onEdit = vi.fn();
  act(() =>
    root?.render(
      <EndpointStates confirming={confirming} endpoint={e} filterError={null} onConfirmFilter={onConfirmFilter} onEdit={onEdit} onRotate={vi.fn()} />,
    ),
  );
  const buttons = [...host.querySelectorAll('button')].map((b) => b.textContent?.trim());
  const disabled = Object.fromEntries([...host.querySelectorAll('button')].map((b) => [b.textContent?.trim(), b.disabled]));
  return { host, buttons, onEdit, disabled };
}

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
});

it('a filter that cannot run is explained as its own hold and offers only an edit, never a one-click confirm', () => {
  const { host, buttons } = render(endpoint('webhook_filter_invalid'));
  const panel = host.querySelector('[data-testid="endpoint-state"][data-state="filter"]');
  expect(panel?.textContent).toContain('Paused because its filter cannot run');
  expect(panel?.textContent).toContain('Nothing is sent while it is held');
  expect(panel?.querySelector('[data-testid="held-filter"]')?.textContent).toBe('action:/(?=x)/');
  expect(buttons).toEqual(['Edit the filter']);
});

it('a filter waiting for review still offers confirm and edit', () => {
  const { buttons } = render(endpoint('webhook_filter_review_required'));
  expect(buttons).toEqual(['Confirm this filter', 'Edit the filter']);
});

it('offers no edit while a filter confirmation is in flight, which would overwrite it', () => {
  expect(render(endpoint('webhook_filter_review_required'), true).disabled).toEqual({ 'Confirm this filter': true, 'Edit the filter': true });
  act(() => root?.unmount());
  document.body.innerHTML = '';
  expect(render(endpoint('webhook_filter_review_required'), false).disabled['Edit the filter']).toBe(false);
});
