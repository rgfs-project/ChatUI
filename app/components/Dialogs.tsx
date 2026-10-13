import * as Dialog from "@radix-ui/react-dialog";
import { useState, type ReactNode } from "react";
import { apiFetch } from "../lib/api";
import { useFocusReturn } from "../lib/focus-return";

/**
 * Dialog primitives (Radix Dialog): focus trap, focus restoration, Escape,
 * portal layering and ARIA labelling. A rounded card over a light scrim; a
 * bottom sheet on phones.
 */
function DialogFrame(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  returnFocus?: () => HTMLElement | null;
  children: ReactNode;
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
          {props.children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

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
  return (
    <DialogFrame
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.title}
      description={props.description}
      returnFocus={props.returnFocus}
    >
      <div className="dialog-actions">
        <Dialog.Close asChild>
          <button type="button" className="btn">
            Cancel
          </button>
        </Dialog.Close>
        <button
          type="button"
          className="btn danger"
          onClick={() => {
            props.onConfirm();
            props.onOpenChange(false);
          }}
        >
          {props.confirmLabel}
        </button>
      </div>
    </DialogFrame>
  );
}

/** Settings → Account → Password. A change signs out every session, this one too. */
export function PasswordDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <DialogFrame
      open={props.open}
      onOpenChange={(open) => {
        if (!open) setError(null);
        props.onOpenChange(open);
      }}
      title="Change password"
      description="You’ll be signed out everywhere."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          setBusy(true);
          void (async () => {
            const response = await apiFetch("/api/auth/password", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                currentPassword: form.get("current"),
                newPassword: form.get("next"),
              }),
            }).catch(() => null);
            setBusy(false);
            if (response?.ok) {
              props.onChanged();
              return;
            }
            const body = (await response?.json().catch(() => null)) as {
              error?: { message?: string };
            } | null;
            setError(body?.error?.message ?? "Couldn’t change the password.");
          })();
        }}
      >
        <label htmlFor="password-current" className="visually-hidden">
          Current password
        </label>
        <input
          id="password-current"
          name="current"
          type="password"
          className="text-input"
          placeholder="Current password"
          autoComplete="current-password"
          required
        />
        <label htmlFor="password-next" className="visually-hidden">
          New password
        </label>
        <input
          id="password-next"
          name="next"
          type="password"
          className="text-input"
          placeholder="New password (10+ characters)"
          autoComplete="new-password"
          minLength={10}
          required
        />
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <Dialog.Close asChild>
            <button type="button" className="btn">
              Cancel
            </button>
          </Dialog.Close>
          <button type="submit" className="btn primary" disabled={busy}>
            Change
          </button>
        </div>
      </form>
    </DialogFrame>
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
    <DialogFrame
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Rename conversation"
      description="1 to 200 characters."
      returnFocus={props.returnFocus}
    >
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
            <button type="button" className="btn">
              Cancel
            </button>
          </Dialog.Close>
          <button type="submit" className="btn primary">
            Rename
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}
