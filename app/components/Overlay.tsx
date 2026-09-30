import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useFocusReturn } from "../lib/focus-return";
import { paths, type OverlayState } from "../lib/paths";

/**
 * URL-backed overlay (INV-53): opened internally it keeps the previous
 * conversation behind it and Back (or Escape/close) returns to it; loaded
 * directly it opens over a new chat and closing goes there.
 */
export function Overlay({
  title,
  children,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  /** A large panel (settings) instead of a dialog-sized one. */
  wide?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const background = (location.state as OverlayState | null)?.background;
  const focus = useFocusReturn();
  const close = () => {
    if (background) void navigate(-1);
    else void navigate(paths.newChat(), { replace: true });
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={`dialog-content overlay-panel${wide ? " overlay-wide" : ""}`}
          data-testid="overlay"
          onCloseAutoFocus={focus.onCloseAutoFocus}
          onOpenAutoFocus={(event) => {
            focus.remember();
            // Focus the panel itself (announced by its title), not its first
            // control, so opening it does not light up the close button.
            event.preventDefault();
            if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
          }}
        >
          <div className="overlay-header">
            <Dialog.Title className="dialog-title">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label="Close" title="Close">
                <X size={18} aria-hidden />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="visually-hidden">{title}</Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
