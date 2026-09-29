import * as Dialog from "@radix-ui/react-dialog";
import { useState, type ReactNode } from "react";

/**
 * Where focus goes when a dialog closes. Radix restores it to the element
 * focused at open time; a dialog opened from a menu item would restore it to
 * that (unmounted) item, so callers pass the menu's trigger instead.
 */
function restoreFocus(target: (() => HTMLElement | null) | undefined) {
  return (event: Event) => {
    const element = target?.();
    if (element?.isConnected) {
      event.preventDefault();
      element.focus();
    }
  };
}

/**
 * Dialog primitives (Radix Dialog): focus trap, focus restoration, Escape,
 * portal layering and ARIA labelling (INV-47). Styled with semantic tokens.
 */
export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content"
          onCloseAutoFocus={restoreFocus(props.returnFocus)}
        >
          <Dialog.Title className="dialog-title">{props.title}</Dialog.Title>
          <Dialog.Description className="dialog-description">
            {props.description}
          </Dialog.Description>
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button type="button" className="secondary">
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="danger"
              onClick={() => {
                props.onConfirm();
                props.onOpenChange(false);
              }}
            >
              {props.confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function RenameDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: string;
  onRename: (title: string) => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const [value, setValue] = useState(props.initial);
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content"
          onCloseAutoFocus={restoreFocus(props.returnFocus)}
        >
          <Dialog.Title className="dialog-title">Rename conversation</Dialog.Title>
          <Dialog.Description className="dialog-description">
            1 to 200 characters.
          </Dialog.Description>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const title = value.trim();
              if (!title) return;
              props.onRename(title);
              props.onOpenChange(false);
            }}
          >
            <label htmlFor="rename-title" className="visually-hidden">
              Title
            </label>
            <input
              id="rename-title"
              className="text-input"
              value={value}
              maxLength={200}
              onChange={(event) => {
                setValue(event.currentTarget.value);
              }}
            />
            <div className="dialog-actions">
              <Dialog.Close asChild>
                <button type="button" className="secondary">
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit">Rename</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
