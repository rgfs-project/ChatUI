import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type ToastKind = "info" | "error";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

type Notify = (message: string, kind?: ToastKind) => void;

const ToastContext = createContext<Notify | null>(null);

const TOAST_MS = 5_000;
let nextId = 1;

/**
 * Native toasts (primitive decision record): one polite live region for
 * confirmations and an assertive one for errors. Toasts never take focus.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const notify = useCallback<Notify>((message, kind = "info") => {
    const id = nextId++;
    setItems((list) => [...list.slice(-2), { id, kind, message }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toasts">
        <div role="status" aria-live="polite" className="toast-region">
          {items
            .filter((t) => t.kind === "info")
            .map((t) => (
              <Toast key={t.id} item={t} onDismiss={dismiss} />
            ))}
        </div>
        <div role="alert" aria-live="assertive" className="toast-region">
          {items
            .filter((t) => t.kind === "error")
            .map((t) => (
              <Toast key={t.id} item={t} onDismiss={dismiss} />
            ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss(item.id);
    }, TOAST_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [item.id, onDismiss]);
  return (
    <div className={`toast toast-${item.kind}`} data-testid="toast">
      <span>{item.message}</span>
      <button
        type="button"
        className="icon-button toast-close"
        aria-label="Dismiss notification"
        onClick={() => {
          onDismiss(item.id);
        }}
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

export function useToast(): Notify {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error("useToast outside ToastProvider");
  return notify;
}
