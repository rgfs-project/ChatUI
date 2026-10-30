import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { claimMenuOpener } from "./menu";

/** Focus return for a dialog that may have been opened from a menu item. */
function useReturnFocus(open: boolean) {
  const target = useRef<HTMLElement | null>(null);
  // Claimed on open (not in onOpenAutoFocus: Radix skips that when a field autofocuses).
  useEffect(() => {
    if (open) target.current = claimMenuOpener();
  }, [open]);
  return {
    onCloseAutoFocus: (event: Event) => {
      const element = target.current;
      target.current = null;
      if (element?.isConnected) {
        event.preventDefault();
        element.focus();
      }
    },
  };
}

export const DialogClose = RadixDialog.Close;

/**
 * Modal dialog on Radix Dialog: focus trap, Escape, focus restoration, inert
 * background and portal layering (INV-47).
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  closeLabel = "Close",
  page = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  closeLabel?: string;
  /** A full-window page: no head row; the content brings its own close control (`DialogClose`). */
  page?: boolean;
}) {
  const focus = useReturnFocus(open);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-backdrop" />
        <RadixDialog.Content
          className={`dialog${className ? ` ${className}` : ""}`}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          // A page starts focused on itself, not on its first control (Tab reaches them in order).
          {...(page
            ? {
                onOpenAutoFocus: (event: Event) => {
                  event.preventDefault();
                  (event.currentTarget as HTMLElement | null)?.focus();
                },
              }
            : {})}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          {page ? (
            <RadixDialog.Title className="visually-hidden">{title}</RadixDialog.Title>
          ) : (
            <div className="dialog-head">
              <RadixDialog.Title className="dialog-title">{title}</RadixDialog.Title>
              <RadixDialog.Close asChild>
                <button type="button" className="icon-button" aria-label={closeLabel}>
                  <X size={18} aria-hidden />
                </button>
              </RadixDialog.Close>
            </div>
          )}
          {description ? (
            <RadixDialog.Description className="dialog-body">{description}</RadixDialog.Description>
          ) : null}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

/** In-app confirmation (never `window.confirm`), on Radix AlertDialog. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);
  const focus = useReturnFocus(request !== null);

  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setRequest(options);
      }),
    [],
  );

  const settle = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setRequest(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog.Root
        open={request !== null}
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="dialog-backdrop" />
          <AlertDialog.Content
            className="dialog confirm-dialog"
            onCloseAutoFocus={focus.onCloseAutoFocus}
          >
            <AlertDialog.Title className="dialog-title">{request?.title}</AlertDialog.Title>
            <AlertDialog.Description className="dialog-body">
              {request?.body}
            </AlertDialog.Description>
            <div className="dialog-actions">
              <AlertDialog.Cancel className="pill-button">Cancel</AlertDialog.Cancel>
              <AlertDialog.Action
                className={`pill-button ${request?.danger ? "pill-danger" : "pill-primary"}`}
                onClick={() => {
                  settle(true);
                }}
              >
                {request?.confirmLabel}
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm outside ConfirmProvider");
  return confirm;
}
