// @vitest-environment happy-dom
import { RETENTION_OPTIONS } from '@logbird/contracts';
import { CodeTabs } from '@logbird/ui/components/code-block';
import { Button, buttonVariants } from '@logbird/ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@logbird/ui/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@logbird/ui/components/ui/select';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupSteps } from './onboarding/setup-steps';
import { RetentionPicker } from './retention-picker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What a screen reader reads: text content without aria-hidden subtrees. */
function spokenText(el: Element) {
  const clone = el.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

/** Let Base UI's composite list register its items and commit focus moves (it does so after a frame). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** A key press; Base UI moves roving focus a frame later, so wait for it. */
async function press(target: Element, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await settle();
}

/** Class tokens of an element, so `focus:outline-hidden` never matches a check for the bare `outline-hidden`. */
const tokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

describe('RetentionPicker (PHONE-08)', () => {
  function Harness({ onChange }: { onChange?: (days: number) => void }) {
    const [days, setDays] = useState(90);
    return (
      <RetentionPicker
        current={90}
        onChange={(d) => {
          setDays(d);
          onChange?.(d);
        }}
        value={days}
      />
    );
  }

  it('exposes the value through exactly one radiogroup with one Tab stop', () => {
    const el = mount(<Harness />);
    const groups = el.querySelectorAll('[role="radiogroup"]');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.getAttribute('aria-label')).toBe('Retention');
    const radios = [...el.querySelectorAll('[role="radio"]')];
    expect(radios).toHaveLength(RETENTION_OPTIONS.length);
    // Each option once; only the checked one is checked.
    expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent)).toEqual(['90 days, recommended, current']);
    // Roving tabindex: the group is one Tab stop.
    expect(radios.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
    // The cards are pointer shortcuts, hidden from AT and out of the Tab order.
    const shortcuts = el.querySelector('[data-testid="retention-shortcuts"]');
    expect(shortcuts?.getAttribute('aria-hidden')).toBe('true');
    for (const b of shortcuts?.querySelectorAll('button') ?? []) expect(b.getAttribute('tabindex')).toBe('-1');
  });

  it('moves the selection with the arrow keys', async () => {
    const onChange = vi.fn();
    const el = mount(<Harness onChange={onChange} />);
    await settle();
    const checked = el.querySelector('[role="radio"][aria-checked="true"]') as HTMLElement;
    act(() => checked.focus());
    await press(checked, 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith(180);
    const now = el.querySelector('[role="radio"][aria-checked="true"]');
    expect(now?.textContent).toBe('180 days');
    expect(document.activeElement).toBe(now);
  });

  it('a shortcut card does not take focus when clicked (it is hidden from assistive tech)', () => {
    const el = mount(<Harness />);
    const card = el.querySelector('[data-testid="retention-shortcuts"] button') as HTMLButtonElement;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      card.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
  });

  it('a shortcut card sets the same single value', () => {
    const onChange = vi.fn();
    const el = mount(<Harness onChange={onChange} />);
    const card = el.querySelector('[data-testid="retention-shortcuts"] button') as HTMLButtonElement;
    act(() => card.click());
    expect(onChange).toHaveBeenLastCalledWith(30);
    expect(el.querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(1);
  });
});

describe('CodeTabs (PHONE-08)', () => {
  const tabs = [
    { id: 'curl', label: 'curl', code: 'curl …', language: 'bash' as const },
    { id: 'sdk', label: 'TypeScript SDK', code: 'logbird.track()', language: 'ts' as const },
    { id: 'fetch', label: 'fetch', code: 'fetch()', language: 'ts' as const },
  ];

  it('is a labelled tablist with one Tab stop; arrows switch the snippet', async () => {
    const el = mount(<CodeTabs tabs={tabs} />);
    await settle();
    const list = el.querySelector('[role="tablist"]');
    expect(list?.getAttribute('aria-label')).toBe('Snippet language');
    const tabEls = [...el.querySelectorAll('[role="tab"]')] as HTMLElement[];
    expect(tabEls).toHaveLength(3);
    expect(tabEls.filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);
    const panel = el.querySelector('[role="tabpanel"]');
    expect(panel?.textContent).toContain('curl');
    act(() => tabEls[0]?.focus());
    await press(tabEls[0] as HTMLElement, 'ArrowRight');
    expect(document.activeElement).toBe(tabEls[1]);
    expect(tabEls[1]?.getAttribute('aria-selected')).toBe('true');
    expect(el.querySelector('[role="tabpanel"]')?.textContent).toContain('logbird.track()');
  });
});

describe('SetupSteps (PHONE-12)', () => {
  const steps = [
    { id: 'profile', label: 'You', done: true },
    { id: 'workspace', label: 'Workspace', done: false },
    { id: 'project', label: 'Project', done: false },
    { id: 'first_event', label: 'First event', done: false },
  ];

  it('reads every step with its position, label and state, and marks the current item', () => {
    const el = mount(<SetupSteps current={1} steps={steps} />);
    const items = [...el.querySelectorAll('li')];
    expect(items.map(spokenText)).toEqual([
      'Step 1 of 4: You, completed',
      'Step 2 of 4: Workspace',
      'Step 3 of 4: Project',
      'Step 4 of 4: First event',
    ]);
    expect(items.map((li) => li.getAttribute('aria-current'))).toEqual([null, 'step', null, null]);
    // Each item is one sr-only string (never display:none); the visible label is hidden from AT so it is not read twice.
    for (const li of items) {
      const srOnly = [...li.querySelectorAll(':scope > .sr-only')];
      expect(srOnly).toHaveLength(1);
      expect(tokens(srOnly[0] as Element)).not.toContain('hidden');
    }
  });
});

describe('forced-colors focus (#85)', () => {
  it('Button paints a system outline only when focus-visible (ring kept)', () => {
    const cls = buttonVariants({ variant: 'ghost' }).split(/\s+/);
    expect(cls).toContain('focus-visible:outline-hidden');
    expect(cls).toContain('focus-visible:ring-3');
    expect(cls).toContain('outline-none');
    expect(cls).not.toContain('outline-hidden');
  });

  it('menu items carry no unconditional outline-hidden (it boxes every item under forced colors)', () => {
    const el = mount(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger render={<Button>Open</Button>} />
        <DropdownMenuContent>
          <DropdownMenuItem>One</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked>Two</DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup value="a">
            <DropdownMenuRadioItem value="a">Three</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const items = [...document.querySelectorAll('[role^="menuitem"]')];
    expect(items.length).toBe(4);
    for (const item of items) {
      expect(tokens(item)).not.toContain('outline-hidden');
      expect(tokens(item)).toContain('focus:outline-hidden');
    }
    expect(el).toBeTruthy();
  });

  it('select items carry no unconditional outline-hidden either (no console screen renders Select yet)', async () => {
    mount(
      <Select defaultOpen defaultValue="30">
        <SelectTrigger aria-label="Window">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="7">7 days</SelectItem>
          <SelectItem value="30">30 days</SelectItem>
        </SelectContent>
      </Select>,
    );
    await settle();
    const items = [...document.querySelectorAll('[data-slot="select-item"]')];
    expect(items.length).toBe(2);
    for (const item of items) {
      expect(tokens(item)).not.toContain('outline-hidden');
      expect(tokens(item)).toContain('focus:outline-hidden');
    }
  });
});
