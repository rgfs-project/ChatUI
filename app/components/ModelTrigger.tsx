import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * The composer's model button: "Qwen 3.6 ⌄". Shared by the placeholder (on
 * the critical path) and the lazy model menu (as its Radix trigger), so both
 * look and are named the same ("Model: …"; Radix owns the trigger's id).
 * Keyboard focus shows as a fill, never a ring.
 */
export function ModelTrigger({
  label,
  ...props
}: { label: string } & Omit<ComponentProps<"button">, "children">) {
  return (
    <button
      type="button"
      className="model-select"
      aria-label={`Model: ${label}`}
      title={label}
      {...props}
    >
      <span className="model-label">{label}</span>
      <ChevronDown size={16} aria-hidden />
    </button>
  );
}
