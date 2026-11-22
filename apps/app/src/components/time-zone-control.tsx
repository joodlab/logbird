import { RadioChoice, RadioGroup } from '@logbird/ui/components/ui/radio-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@logbird/ui/components/ui/tooltip';
import { cn } from '@logbird/ui/lib/utils';
import { useId } from 'react';
import { BROWSER_ZONE, setZonePreference, shortZoneLabel, useZonePreference, type ZonePreference, zoneFor } from '@/lib/time-zone';

/**
 * The explorer's time column header: names the zone the column is in and switches between the browser's zone and
 * UTC in one click (the choice is saved for this browser and applies to every time in the console).
 */
export function TimeColumnHeader() {
  const preference = useZonePreference();
  const zone = zoneFor(preference);
  const next: ZonePreference = preference === 'utc' ? 'local' : 'utc';
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={`Times in ${zone}. Show times in ${zoneFor(next)} instead.`}
            className="-mx-1 truncate rounded-sm px-1 uppercase tracking-wider outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={() => setZonePreference(next)}
            type="button"
          />
        }
      >
        Time · {shortZoneLabel(zone)}
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        Times are in {zone}. Click to show {zoneFor(next)} (exports and the API use UTC). Saved for this browser.
      </TooltipContent>
    </Tooltip>
  );
}

/** Account setting: which zone the console shows times in. */
export function TimeZoneSetting() {
  const preference = useZonePreference();
  const label = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-medium text-sm" id={label}>
        Show times in
      </span>
      <RadioGroup
        aria-labelledby={label}
        className="grid gap-2 sm:grid-cols-2"
        onValueChange={(value) => setZonePreference(value as ZonePreference)}
        value={preference}
      >
        <RadioChoice value="local">
          <span className="font-medium text-sm">Your time zone</span>
          <span className="text-muted-foreground text-xs">{BROWSER_ZONE}, as set on this device</span>
        </RadioChoice>
        <RadioChoice value="utc">
          <span className="font-medium text-sm">UTC</span>
          <span className="text-muted-foreground text-xs">The same as exports and the API</span>
        </RadioChoice>
      </RadioGroup>
      <p className="text-muted-foreground text-xs">Saved for this browser. Every time in the console follows it, and tooltips always show both.</p>
    </div>
  );
}

/** " · Berlin time": a compact zone label that switches Local/UTC, for places without a time column header (phones). */
export function TimeZoneInline({ className }: { className?: string }) {
  const preference = useZonePreference();
  const zone = zoneFor(preference);
  const next: ZonePreference = preference === 'utc' ? 'local' : 'utc';
  return (
    <span className={cn('text-muted-foreground', className)}>
      {' · '}
      <button
        aria-label={`Times in ${zone}. Show times in ${zoneFor(next)} instead.`}
        className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        onClick={() => setZonePreference(next)}
        type="button"
      >
        {shortZoneLabel(zone)} time
      </button>
    </span>
  );
}
