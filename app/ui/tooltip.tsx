import * as RadixTooltip from "@radix-ui/react-tooltip";
import { useState, type ReactElement, type ReactNode } from "react";

/** One provider at the shell root; tooltips open on hover and keyboard focus. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  );
}

/**
 * Supplementary label only: the trigger must already have an accessible name
 * (tooltips are not announced reliably and never appear on touch).
 */
export function Tooltip({
  label,
  side = "bottom",
  children,
}: {
  label: string;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactElement;
}) {
  // Never opened on a phone: an invisible open tooltip would swallow the
  // first Escape meant for the drawer or dialog around it.
  const [open, setOpen] = useState(false);
  return (
    <RadixTooltip.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next && !document.documentElement.hasAttribute("data-phone"));
      }}
    >
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="tooltip" side={side} sideOffset={6} collisionPadding={8}>
          {label}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
