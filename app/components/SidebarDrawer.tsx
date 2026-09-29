import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Sidebar } from "./Sidebar";

/**
 * The sidebar below the breakpoint (Phase 11): a modal drawer on Radix
 * Dialog, per the Phase 7 primitive decision record. Focus is trapped inside,
 * Escape and the backdrop dismiss it, focus returns to the menu button, and
 * the background is hidden from assistive technology (and made `inert` by
 * the layout). Loaded on demand: never in the critical chat bundle. There is
 * no swipe-to-dismiss, so a horizontal scroll can't close it by accident.
 */
export default function SidebarDrawer(props: {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Focus goes back here on close (a touch tap may not have focused it). */
  returnFocus: () => HTMLElement | null;
}) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" data-testid="drawer-backdrop" />
        <Dialog.Content
          className="drawer-content"
          data-testid="sidebar-drawer"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            const target = props.returnFocus();
            if (target) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          <div className="drawer-header">
            <Dialog.Title className="dialog-title">Conversations</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="icon-button" aria-label="Close conversations">
                <X size={18} aria-hidden />
              </button>
            </Dialog.Close>
          </div>
          <Sidebar userId={props.userId} hidden={false} navId="sidebar-drawer-nav" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
