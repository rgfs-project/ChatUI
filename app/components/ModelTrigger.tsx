import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * "Gemma 4 ⌄" in the composer. The critical-path placeholder and the lazy
 * model menu's Radix trigger share it, so both look and are named alike.
 */
export function ModelTrigger({
  label,
  ...props
}: { label: string } & Omit<ComponentProps<"button">, "children">) {
  return (
    <button
      type="button"
      className="model-trigger"
      aria-label={`Model: ${label}`}
      title={label}
      {...props}
    >
      <span className="model-label">{label}</span>
      <ChevronDown size={16} aria-hidden />
    </button>
  );
}
