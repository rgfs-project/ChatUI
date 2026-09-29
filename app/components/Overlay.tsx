import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { paths, type OverlayState } from "../lib/paths";

/**
 * URL-backed overlay (INV-53): opened internally it keeps the previous
 * conversation behind it and Back (or Escape/close) returns to it; loaded
 * directly it opens over a new chat and closing goes there.
 */
export function Overlay({ title, children }: { title: string; children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const background = (location.state as OverlayState | null)?.background;
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
        <Dialog.Content className="dialog-content overlay-panel" data-testid="overlay">
          <div className="overlay-header">
            <Dialog.Title className="dialog-title">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="icon-button" aria-label="Close" title="Close">
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
