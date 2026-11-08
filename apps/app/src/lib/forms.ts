/** First human-readable message from a TanStack Form field's error list (strings or Standard Schema issues). */
export function fieldErrorMessage(errors: readonly unknown[]): string | undefined {
  for (const error of errors) {
    if (!error) continue;
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
      return (error as { message: string }).message;
    }
  }
  return undefined;
}

/** The slice of a TanStack Form field that {@link changeAndRevalidate} needs. */
interface RevalidatingField<T> {
  handleChange: (value: T) => void;
  validate: (cause: 'blur') => unknown;
  state: { meta: { errorMap: { onBlur?: unknown } } };
}

/**
 * Change a field and, if a blur validator already flagged it, re-run that validator right away. TanStack Form keeps a
 * blur error until the next blur, so without this an Enter-submit after fixing the value is blocked by the stale error
 * (tab past an empty email, come back, type a valid one, press Enter). Errors still only appear on blur or submit.
 */
export function changeAndRevalidate<T>(field: RevalidatingField<T>, value: T) {
  field.handleChange(value);
  if (field.state.meta.errorMap.onBlur) field.validate('blur');
}
