import * as Dialog from "@radix-ui/react-dialog";
import { useState, type ReactNode } from "react";
import { useFocusReturn } from "../lib/focus-return";

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
  /** Where focus goes on close (a menu's trigger); otherwise the element that opened it. */
  returnFocus?: () => HTMLElement | null;
}) {
  const focus = useFocusReturn(props.returnFocus);
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content"
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
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
  const focus = useFocusReturn(props.returnFocus);
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content"
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
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
