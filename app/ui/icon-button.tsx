import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Tooltip } from "./tooltip";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name; also the tooltip text unless `tooltip` is false. */
  label: string;
  tooltip?: boolean;
  tooltipSide?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, tooltip = true, tooltipSide, className, children, ...rest },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={`icon-button${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
  return tooltip ? (
    <Tooltip label={label} {...(tooltipSide ? { side: tooltipSide } : {})}>
      {button}
    </Tooltip>
  ) : (
    button
  );
});
