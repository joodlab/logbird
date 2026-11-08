import { FieldApi, FormApi } from '@tanstack/react-form';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { changeAndRevalidate } from './forms';

const emailSchema = z.email('Enter a valid email address.');

/** The login email field: blur + submit validators, exactly as on /login. */
function emailForm() {
  let submitted = 0;
  const form = new FormApi({
    defaultValues: { email: '' },
    onSubmit: async () => {
      submitted++;
    },
  });
  form.mount();
  const field = new FieldApi({ form, name: 'email', validators: { onSubmit: emailSchema, onBlur: emailSchema } });
  field.mount();
  return { form, field, submitted: () => submitted };
}

describe('changeAndRevalidate (PHONE-07)', () => {
  it('reproduces the bug without it: a stale blur error blocks the first Enter', async () => {
    const { form, field, submitted } = emailForm();
    field.handleBlur(); // tab past the empty field
    field.handleChange('vera@example.test');
    expect(field.state.meta.errors).toHaveLength(1);
    await form.handleSubmit();
    expect(submitted()).toBe(0);
  });

  it('clears the blur error once the value is valid, so the first Enter submits', async () => {
    const { form, field, submitted } = emailForm();
    field.handleBlur();
    changeAndRevalidate(field, 'vera@');
    expect(field.state.meta.errors).toHaveLength(1); // still invalid: the message stays
    changeAndRevalidate(field, 'vera@example.test');
    expect(field.state.meta.errors).toHaveLength(0);
    await form.handleSubmit();
    expect(submitted()).toBe(1);
  });

  it('does not validate while typing before the first blur', () => {
    const { field } = emailForm();
    changeAndRevalidate(field, 'v');
    expect(field.state.meta.errors).toHaveLength(0);
  });
});
