import { Input } from '@logbird/ui/components/ui/input';
import { Label } from '@logbird/ui/components/ui/label';
import { Textarea } from '@logbird/ui/components/ui/textarea';
import { type ReactNode, useState } from 'react';

/**
 * The line under a field: its short purpose by default, its limits while it is focused, its error once invalid. The
 * limits stay in the field's accessible description throughout (visually hidden when not shown), so a screen reader
 * hears them on focus; the dialog stays short until someone is filling a field in.
 */
export function FieldHint({
  id,
  purpose,
  limits,
  error,
  focused,
}: {
  id: string;
  purpose?: ReactNode;
  limits: ReactNode;
  error?: string;
  focused: boolean;
}) {
  return (
    <>
      {error ? (
        <p className="text-destructive text-xs" id={`${id}-hint`}>
          {error}
        </p>
      ) : purpose ? (
        // Hidden visually (not removed) while the limits show, so the field's description never points at nothing.
        <p className={focused ? 'sr-only' : 'text-muted-foreground text-xs'} id={`${id}-hint`}>
          {purpose}
        </p>
      ) : null}
      <p className={focused && !error ? 'text-muted-foreground text-xs' : 'sr-only'} id={`${id}-limits`}>
        {limits}
      </p>
    </>
  );
}
/** The field's description: its hint line when it has one (purpose or error), and its limits. */
export const describedBy = (id: string, hasHint = true) => (hasHint ? `${id}-hint ${id}-limits` : `${id}-limits`);

/** A labelled text field with its purpose, its limits while focused, and its error (see `FieldHint`). */
export function TextField({
  id,
  label,
  optional,
  purpose,
  limits,
  error,
  multiline,
  ...props
}: {
  id: string;
  label: string;
  optional?: boolean;
  purpose?: ReactNode;
  limits: ReactNode;
  error: string | undefined;
  multiline?: boolean;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const common = {
    'aria-describedby': describedBy(id, Boolean(error || purpose)),
    'aria-invalid': Boolean(error) || undefined,
    autoCapitalize: 'off',
    autoComplete: 'off',
    className: 'font-mono',
    id,
    onBlur: () => setFocused(false),
    onChange: (e: { target: { value: string } }) => props.onChange(e.target.value),
    onFocus: () => setFocused(true),
    placeholder: props.placeholder,
    spellCheck: false,
    value: props.value,
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {optional ? <span className="font-normal text-muted-foreground"> · optional</span> : null}
      </Label>
      {multiline ? <Textarea {...common} rows={2} /> : <Input {...common} />}
      <FieldHint error={error} focused={focused} id={id} limits={limits} purpose={purpose} />
    </div>
  );
}
