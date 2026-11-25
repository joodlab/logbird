// @vitest-environment happy-dom
import type { ChangeValueKind } from '@logbird/contracts';
import { TooltipProvider } from '@logbird/ui/components/ui/tooltip';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { EventChange } from '@/lib/change-values';
import { ChangeSummary, changeSummaryLabel } from './change-summary';
import { ChangeValue } from './change-value';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: React.ReactNode, verify: (host: HTMLElement) => void) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<TooltipProvider>{node}</TooltipProvider>));
    verify(host);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
}

const change = (field: string, before: string, after: string, beforeKind?: ChangeValueKind, afterKind?: ChangeValueKind): EventChange => ({
  field,
  before,
  after,
  beforeKind,
  afterKind,
});

describe('change values', () => {
  const cases = [
    ['absent', '', 'not set'],
    ['null', 'null', 'null'],
    ['string', 'null', '"null"'],
    ['string', '', '""'],
    ['number', '9007199254740993', '9007199254740993'],
    ['boolean', 'false', 'false'],
    ['json', '{"tag":[1]}', '{"tag":[1]}'],
    [undefined, '', '∅'],
    [undefined, '10', '10'],
    ['string', '[redacted]', 'value redacted'],
  ] as const;

  it.each(cases)('shows %s value %j on either side', (kind, text, displayed) => {
    render(
      <>
        <ChangeValue before kind={kind} text={text} />
        <ChangeValue kind={kind} text={text} />
      </>,
      (host) => expect([...host.children].map((element) => element.textContent)).toEqual([displayed, displayed]),
    );
  });

  it('mutes only the redacted side and leaves custom markers visible', () => {
    render(<ChangeSummary changes={[change('token', '[redacted]', '[hidden]', 'string', 'string')]} onOpen={vi.fn()} />, (host) => {
      expect(host.textContent).toBe('token: value redacted → "[hidden]"');
      expect(host.querySelector('.italic')?.textContent).toBe('value redacted');
      expect(host.querySelector('.text-diff-add')?.textContent).toBe('"[hidden]"');
    });
  });

  it('truncates in the middle with a focusable control carrying the full value', () => {
    const text = `begin-${'12345'.repeat(20)}-end`;
    render(<ChangeSummary changes={[change('note', '', text, 'absent', 'string')]} onOpen={vi.fn()} />, (host) => {
      const button = host.querySelector('button');
      expect(button?.textContent).toMatch(/^"begin-.*….*-end"$/u);
      expect(button?.getAttribute('aria-label')).toBe(JSON.stringify(text));
      act(() => button?.focus());
      expect(document.activeElement).toBe(button);
    });
  });
});

describe('history change summary', () => {
  it('keeps visually significant whitespace and labels unnamed fields', () => {
    const entry = change('', 'A  B', 'A B', 'string', 'string');
    const filter = vi.fn();
    render(<ChangeSummary changes={[entry]} onField={filter} onOpen={vi.fn()} />, (host) => {
      const button = host.querySelector('button');
      expect(button?.textContent).toBe('Unnamed field');
      expect(button?.getAttribute('aria-label')).toBe('Filter history by Unnamed field');
      act(() => button?.click());
      expect(filter).toHaveBeenCalledExactlyOnceWith('');
      expect([...host.querySelectorAll('.whitespace-break-spaces')].map((node) => node.textContent)).toEqual(['"A  B"', '"A B"']);
    });
  });

  it.each(['a  b', ' a', 'a ', 'a\n b', 'a\t b'])('preserves %j in the compact summary and full value', (value) => {
    const encoded = JSON.stringify(value);
    render(
      <>
        <ChangeSummary changes={[change('title', value, 'C', 'string', 'string')]} onOpen={vi.fn()} />
        <ChangeValue kind="string" text={value} />
      </>,
      (host) => {
        expect([...host.querySelectorAll('.whitespace-break-spaces')].map((node) => node.textContent)).toEqual([encoded, '"C"', encoded]);
      },
    );
  });

  it.each([
    ['absent', 'absent', 'not set → not set'],
    ['absent', undefined, 'not set → ∅'],
    [undefined, 'absent', '∅ → not set'],
    [undefined, undefined, '∅ → ∅'],
  ] as const)('makes no transition claim for blanks with kinds %s and %s', (beforeKind, afterKind, expected) => {
    const entries = [change('note', '', '', beforeKind, afterKind)];
    render(<ChangeSummary changes={entries} onOpen={vi.fn()} />, (host) => {
      expect(host.textContent).toBe(`note: ${expected}`);
    });
    expect(changeSummaryLabel(entries)).toBe(`note: ${expected.replace(' → ', ' to ')}`);
  });

  it('names a creation, removal and legacy change without guessing absent kinds', () => {
    const creation = change('title', '', '', 'absent', 'string');
    const removal = change('note', 'null', '', 'null', 'absent');
    const legacy = change('status', '', 'true');
    expect(changeSummaryLabel([creation, removal, legacy])).toBe('title: set to ""; note: removed (was null); 1 more change');
    render(<ChangeSummary changes={[creation, removal]} onOpen={vi.fn()} />, (host) => {
      expect(host.textContent).toBe('title: set to ""note: removed (was null)');
    });
    render(<ChangeSummary changes={[legacy]} onOpen={vi.fn()} />, (host) => {
      expect(host.textContent).toBe('status: ∅ → true');
    });
  });

  it('shows two entries in recorded order and exposes the exact remaining count', () => {
    const changes = [
      change('title', 'Spring guide', 'Spring guide 2027', 'string', 'string'),
      change('published', 'false', 'true', 'boolean', 'boolean'),
      change('subtitle', 'before', 'after'),
      change('category', 'before', 'after'),
    ];
    const open = vi.fn();
    const filter = vi.fn();
    render(<ChangeSummary changes={changes} onField={filter} onOpen={open} />, (host) => {
      expect(host.textContent).toBe('title: "Spring guide" → "Spring guide 2027"published: false → true+2 more');
      const [field, , more] = host.querySelectorAll('button');
      act(() => field?.click());
      expect(filter).toHaveBeenCalledExactlyOnceWith('title');
      expect(open).not.toHaveBeenCalled();
      act(() => more?.click());
      expect(open).toHaveBeenCalledTimes(1);
    });
    expect(changeSummaryLabel(changes)).toContain('2 more changes');
  });
});
