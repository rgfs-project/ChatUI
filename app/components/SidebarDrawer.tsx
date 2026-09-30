import * as Dialog from "@radix-ui/react-dialog";
import { Sidebar, type SidebarUser } from "./Sidebar";

/**
 * The sidebar below the breakpoint (Phase 11): a modal drawer on Radix
 * Dialog, per the Phase 7 primitive decision record. Focus is trapped inside,
 * Escape and the backdrop dismiss it, focus returns to the button that opened
 * it, and the background is hidden from assistive technology (and made
 * `inert` by the layout). Loaded on demand: never in the critical chat
 * bundle. There is no swipe-to-dismiss, so a horizontal scroll can't close it.
 */
export default function SidebarDrawer(props: {
  user: SidebarUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Focus goes back here on close (a touch tap may not have focused it). */
  returnFocus: () => HTMLElement | null;
}) {
  const close = () => {
    props.onOpenChange(false);
  };
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
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          <Dialog.Title className="visually-hidden">Conversations</Dialog.Title>
          <Sidebar
            user={props.user}
            hidden={false}
            drawer
            navId="sidebar-drawer-nav"
            hideLabel="Close conversations"
            onHide={close}
            onNavigate={close}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
