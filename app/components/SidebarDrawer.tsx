import * as Dialog from "@radix-ui/react-dialog";
import { Sidebar, type SidebarUser } from "./Sidebar";

/**
 * The sidebar on phones: a 260px drawer over a scrim (Radix Dialog). Focus is
 * trapped inside, Escape and the scrim close it, focus goes back to the button
 * that opened it, and the page behind is inert. Loaded on demand. No swipe to
 * dismiss, so scrolling sideways can't close it by accident.
 */
export default function SidebarDrawer(props: {
  user: SidebarUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Focus returns here (a tap may not have focused the trigger). */
  returnFocus: () => HTMLElement | null;
}) {
  const close = () => {
    props.onOpenChange(false);
  };
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay drawer-overlay" data-testid="drawer-backdrop" />
        <Dialog.Content
          className="drawer"
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
            collapsed={false}
            drawer
            navId="sidebar-drawer-nav"
            onToggle={close}
            onNavigate={close}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
