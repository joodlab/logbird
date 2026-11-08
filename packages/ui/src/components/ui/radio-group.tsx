import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "../../lib/utils";
import { filterChipClassName } from "../filter-chip";

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
	return (
		<RadioGroupPrimitive
			className={cn("grid w-full gap-2", className)}
			data-slot="radio-group"
			{...props}
		/>
	);
}

function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
	return (
		<RadioPrimitive.Root
			className={cn(
				"group/radio-group-item peer relative flex aspect-square size-4 shrink-0 rounded-full border border-input outline-none group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-input after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-has-[:focus-visible]/field-label:data-checked:border-primary dark:data-checked:bg-primary",
				className
			)}
			data-slot="radio-group-item"
			{...props}
		>
			<RadioPrimitive.Indicator
				className="flex size-4 items-center justify-center"
				data-slot="radio-group-indicator"
			>
				<span className="absolute top-1/2 start-1/2 size-2 -translate-x-1/2 rtl:translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-foreground" />
			</RadioPrimitive.Indicator>
		</RadioPrimitive.Root>
	);
}

const radioCardClassName =
	"flex cursor-pointer flex-col items-start gap-0.5 rounded-lg border bg-card p-3 text-start outline-none transition-colors hover:border-foreground/25 focus-visible:outline-hidden focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:border-brand data-checked:ring-1 data-checked:ring-brand data-disabled:cursor-not-allowed data-disabled:opacity-60 data-disabled:hover:border-border data-checked:data-disabled:hover:border-brand forced-colors:data-checked:border-[Highlight]";

/**
 * A whole card or chip as one radio of a `RadioGroup`: one Tab stop per group, arrow keys move the selection
 * (Base UI roving focus). Use instead of `button role="radio"`. The chip looks exactly like `FilterChip`.
 */
function RadioChoice({
	className,
	variant = "card",
	...props
}: RadioPrimitive.Root.Props & { variant?: "card" | "chip" }) {
	return (
		<RadioPrimitive.Root
			className={(state) =>
				cn(
					variant === "chip"
						? cn(
								filterChipClassName(state.checked),
								"data-disabled:pointer-events-none data-disabled:opacity-50",
							)
						: radioCardClassName,
					typeof className === "function" ? className(state) : className,
				)
			}
			data-slot="radio-choice"
			{...props}
		/>
	);
}

export { RadioChoice, RadioGroup, RadioGroupItem };
