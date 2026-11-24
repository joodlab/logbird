import { Input } from '@logbird/ui/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@logbird/ui/components/ui/native-select';
import { RadioChoice, RadioGroup } from '@logbird/ui/components/ui/radio-group';
import { useState } from 'react';
import { describedBy, FieldHint } from '@/components/text-field';
import type { Form, WindowUnit } from '@/lib/webhooks';

/**
 * How late an event may arrive and still be delivered (#152): within a whole number of hours or days of happening, or
 * "No limit". Events that arrive later (an import, a backfill, a producer that was offline) are stored and searchable
 * as usual; only this endpoint skips them.
 */
export function DeliveryWindowField({
  id,
  value,
  error,
  onChange,
}: {
  id: string;
  value: Pick<Form, 'windowLimited' | 'windowAmount' | 'windowUnit'>;
  error: string | undefined;
  onChange: (patch: Partial<Pick<Form, 'windowLimited' | 'windowAmount' | 'windowUnit'>>) => void;
}) {
  // The limits show while the amount or the unit has focus.
  const [focused, setFocused] = useState(false);
  const focus = () => setFocused(true);
  const blur = () => setFocused(false);
  return (
    <fieldset aria-describedby={describedBy(id)} className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 font-medium text-sm">Delivery window</legend>
      <RadioGroup
        aria-label="Delivery window"
        className="flex flex-wrap gap-2"
        // No focus handlers here: the hint swapping for the longer limits would move the centred dialog between press
        // and release, and the click would miss the chip. The amount and unit show the limits on focus.
        onValueChange={(v) => onChange({ windowLimited: v === 'limited' })}
        value={value.windowLimited ? 'limited' : 'none'}
      >
        <RadioChoice value="limited" variant="chip">
          Events that arrive within a time
        </RadioChoice>
        <RadioChoice value="none" variant="chip">
          No limit
        </RadioChoice>
      </RadioGroup>
      {value.windowLimited ? (
        <div className="flex items-center gap-2">
          <Input
            aria-describedby={describedBy(id)}
            aria-invalid={Boolean(error) || undefined}
            aria-label="Delivery window amount"
            className="w-24 tabular-nums"
            id={`${id}-amount`}
            inputMode="numeric"
            onBlur={blur}
            onFocus={focus}
            onChange={(e) => onChange({ windowAmount: e.target.value })}
            value={value.windowAmount}
          />
          <NativeSelect
            aria-describedby={describedBy(id)}
            aria-label="Delivery window unit"
            id={`${id}-unit`}
            onBlur={blur}
            onFocus={focus}
            onChange={(e) => onChange({ windowUnit: e.target.value as WindowUnit })}
            value={value.windowUnit}
          >
            <NativeSelectOption value="hours">hours</NativeSelectOption>
            <NativeSelectOption value="days">days</NativeSelectOption>
          </NativeSelect>
          <span className="text-muted-foreground text-sm">of happening</span>
        </div>
      ) : null}
      <FieldHint
        error={error}
        focused={focused}
        id={id}
        limits="Whole hours, from 1 hour to 3,650 days; new endpoints start at 7 days. A change applies to events found after you save: deliveries already queued still go out. Resends and test pings ignore the window."
        purpose={
          value.windowLimited
            ? 'Events that arrive later (an import, a backfill, a producer that was offline) are stored and searchable, but this endpoint does not send them.'
            : 'Every matching event is sent, however long after it happened it arrives.'
        }
      />
    </fieldset>
  );
}
