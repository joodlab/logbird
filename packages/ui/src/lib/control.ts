/**
 * The control size scale shared by every control that can sit in a row (Button, Input, InputGroup, SelectTrigger,
 * NativeSelect, Toggle/ToggleGroup, SegmentedControl, TabsList). Heights come from the `--control-size-*` tokens in
 * globals.css, so a toolbar mixing any of them lines up:
 *
 *   sm      → --control-size-compact (32px)  toolbars, filters, row and card-header actions, the top bar
 *   default → --control-size-default (36px)  forms, dialogs, settings
 *   lg      → --control-size-large   (40px)  sign-in, onboarding and join pages
 */
export type ControlSize = 'sm' | 'default' | 'lg';

/** Older `density` props map onto the scale ("compact" = sm). */
export type ControlDensity = 'default' | 'compact';

export function controlSize(size: ControlSize | undefined, density?: ControlDensity): ControlSize {
  return size ?? (density === 'compact' ? 'sm' : 'default');
}
