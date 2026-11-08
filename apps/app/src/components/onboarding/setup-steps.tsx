import { cn } from '@logbird/ui/lib/utils';
import { CheckIcon } from 'lucide-react';

export interface SetupStep {
  id: string;
  label: string;
  done: boolean;
}

/**
 * Onboarding progress. On phone only the current label is shown, but each item always carries one sr-only string
 * ("Step 1 of 4: You, completed"), so a screen reader hears every step and its state, and the current item carries
 * aria-current="step".
 */
export function SetupSteps({ steps, current }: { steps: readonly SetupStep[]; current: number }) {
  return (
    <ol aria-label="Setup progress" className="flex items-center gap-2 text-sm">
      {steps.map((step, i) => {
        const isCurrent = i === current;
        const isDone = step.done && !isCurrent;
        return (
          <li aria-current={isCurrent ? 'step' : undefined} className="flex items-center gap-2" data-done={step.done || undefined} key={step.id}>
            <span
              aria-hidden
              className={cn(
                'flex size-6 items-center justify-center rounded-full border font-medium text-xs tabular-nums transition-colors',
                isDone && 'border-transparent bg-foreground text-background',
                isCurrent && 'border-brand bg-brand/10 text-brand',
                !isDone && !isCurrent && 'text-muted-foreground',
              )}
            >
              {isDone ? <CheckIcon className="size-3.5" /> : i + 1}
            </span>
            {/* One spoken string (no stray separators between sr-only fragments); the visible label is hidden from AT. */}
            <span className="sr-only">{`Step ${i + 1} of ${steps.length}: ${step.label}${isDone ? ', completed' : ''}`}</span>
            <span aria-hidden className={cn(isCurrent ? 'font-medium text-foreground' : 'hidden text-muted-foreground sm:inline')}>
              {step.label}
            </span>
            {i < steps.length - 1 ? <span aria-hidden className="mx-1 h-px w-4 bg-border sm:w-10" /> : null}
          </li>
        );
      })}
    </ol>
  );
}
