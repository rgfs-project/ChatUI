import * as RadixDialog from "@radix-ui/react-dialog";
import { useUi } from "../lib/ui-context";
import { Sidebar } from "./sidebar";

/**
 * The sidebar as a modal drawer on phones and narrow windows (Phase 11):
 * focus trap, Escape and backdrop dismissal, inert background, focus returns
 * to the button that opened it. Choosing something closes it.
 */
export function Drawer() {
  const { narrowOpen, closeNarrow } = useUi();
  return (
    <RadixDialog.Root
      open={narrowOpen}
      onOpenChange={(open) => {
        if (!open) closeNarrow();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-backdrop drawer-backdrop" />
        <RadixDialog.Content
          className="drawer"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            // Back to the button that opened it (it may not have kept focus on touch).
            const opener = document.querySelector<HTMLElement>(".chat-header .sidebar-open");
            if (opener) {
              event.preventDefault();
              opener.focus();
            }
          }}
        >
          <RadixDialog.Title className="visually-hidden">Chats</RadixDialog.Title>
          <Sidebar />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
