import * as Dialog from "@radix-ui/react-dialog";
import { useState, type ReactNode } from "react";
import { apiFetch } from "../lib/api";
import { useFocusReturn } from "../lib/focus-return";

/**
 * Dialogs on Radix Dialog: focus trap, Escape, portal layering, labelling,
 * and focus back to whatever opened them. A card on wide screens; on phones
 * the same element becomes a bottom sheet with a grab handle (CSS only).
 */
export function DialogFrame(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  /** Visually hidden description (still read by screen readers). */
  hideDescription?: boolean;
  wide?: boolean;
  className?: string;
  returnFocus?: () => HTMLElement | null;
  children?: ReactNode;
}) {
  const focus = useFocusReturn(props.returnFocus);
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          className={`dialog${props.wide ? " wide" : ""}${props.className ? ` ${props.className}` : ""}`}
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
        >
          <span className="sheet-handle" aria-hidden />
          <Dialog.Title className="dialog-title">{props.title}</Dialog.Title>
          <Dialog.Description className={props.hideDescription ? "visually-hidden" : "dialog-desc"}>
            {props.description}
          </Dialog.Description>
          {props.children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const DialogClose = Dialog.Close;

function CancelButton() {
  return (
    <Dialog.Close asChild>
      <button type="button" className="btn dialog">
        Cancel
      </button>
    </Dialog.Close>
  );
}

/** "Delete all chats?" — a question, Cancel and one (usually destructive) action. */
export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  /** A non-destructive confirmation gets the blue button. */
  tone?: "danger" | "primary";
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
        <CancelButton />
        <button
          type="button"
          className={`btn dialog ${props.tone === "primary" ? "primary" : "danger"}`}
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

/** One line of text: a title, a project name, a display name. */
export function TextDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  label: string;
  initial: string;
  submitLabel: string;
  maxLength: number;
  type?: "text" | "email";
  /** Allow saving an empty value (clears an optional field). */
  allowEmpty?: boolean;
  onSubmit: (value: string) => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const [value, setValue] = useState(props.initial);
  const id = `text-dialog-${props.label.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <DialogFrame
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.title}
      description={props.description}
      returnFocus={props.returnFocus}
    >
      <form
        className="dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          const next = value.trim();
          if (!next && !props.allowEmpty) return;
          props.onSubmit(next);
          props.onOpenChange(false);
        }}
      >
        <label htmlFor={id} className="visually-hidden">
          {props.label}
        </label>
        <input
          id={id}
          className="input"
          type={props.type ?? "text"}
          value={value}
          maxLength={props.maxLength}
          placeholder={props.label}
          onChange={(event) => {
            setValue(event.currentTarget.value);
          }}
        />
        <div className="dialog-actions">
          <CancelButton />
          <button type="submit" className="btn dialog primary">
            {props.submitLabel}
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
  return (
    <TextDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Rename conversation"
      description="1 to 200 characters."
      label="Title"
      initial={props.initial}
      submitLabel="Rename"
      maxLength={200}
      onSubmit={props.onRename}
      returnFocus={props.returnFocus}
    />
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
        className="dialog-body"
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
          className="input"
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
          className="input"
          placeholder="New password (10+ characters)"
          autoComplete="new-password"
          minLength={10}
          required
        />
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <CancelButton />
          <button type="submit" className="btn dialog primary" disabled={busy}>
            Change
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}
