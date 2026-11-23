// @vitest-environment happy-dom
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@logbird/ui/components/ui/command';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { paletteEntityValue } from '@/lib/entities';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
});

// As the server ranks them for `act`: the tenant whose id starts with it, then the actor whose name contains it.
const ranked = [
  { kind: 'tenant' as const, id: 'actual27', name: 'Actual Clinics' },
  { kind: 'actor' as const, id: 'bob', name: 'Contact Desk' },
];

/** The palette's entity group as cmdk shows it for `search`, with each row value from `rowValue`. */
function shownOrder(search: string, rowValue: (e: (typeof ranked)[number]) => string): string[] {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <Command>
        <CommandInput value={search} />
        <CommandList>
          <CommandGroup heading="Entities">
            {ranked.map((e) => (
              <CommandItem key={`${e.kind}:${e.id}`} value={rowValue(e)}>
                {e.name}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>,
    ),
  );
  return [...host.querySelectorAll('[cmdk-item]')].map((n) => n.textContent ?? '');
}

it('keeps the server rank order for entities instead of re-sorting them by kind (#239)', () => {
  expect(shownOrder('act', (e) => paletteEntityValue('act', e))).toEqual(['Actual Clinics', 'Contact Desk']);
});

it('(the old values let cmdk put the actor first, because its value started with "actor")', () => {
  expect(shownOrder('act', (e) => `${e.kind} ${e.id} ${e.name} act`)).toEqual(['Contact Desk', 'Actual Clinics']);
});
