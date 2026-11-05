import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { type ControlDensity, type ControlSize, controlSize } from '../../lib/control'
import { cn } from '../../lib/utils'

type InputProps = Omit<React.ComponentProps<"input">, "size"> & {
  /** Control scale (lib/control.ts). */
  size?: ControlSize
  /** @deprecated use `size` ("compact" = "sm"). */
  density?: ControlDensity
}

function Input({ className, type, size, density, ...props }: InputProps) {
  const resolved = controlSize(size, density)
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      data-size={resolved}
      data-density={resolved === "sm" ? "compact" : "default"}
      className={cn(
        "h-(--control-size-default) data-[size=sm]:h-(--control-size-compact) data-[size=lg]:h-(--control-size-large) w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
