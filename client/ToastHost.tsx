import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { onToast, type Toast, type ToastTone } from './toast.ts';

/**
 * Mac-style corner notifications for the toasts fired by `showToast`.
 *
 * Mounted once, above the router (see `Root.tsx`), so a toast fired while
 * signing in survives the redirect that follows and one fired from Settings
 * outlives the panel closing.
 */

const VISIBLE_MS = 4000;
/** Matches `--motion-fast`, which `.toast`'s transition is keyed to. */
const FADE_MS = 120;

const CLASS_NAME: Record<ToastTone, string> = {
  success: 'notice',
  warning: 'warning',
  error: 'error',
};

const ICON: Record<ToastTone, typeof CircleCheck> = {
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
};

interface Displayed extends Toast {
  leaving: boolean;
}

export function ToastHost(): React.JSX.Element {
  const [toasts, setToasts] = useState<Displayed[]>([]);
  // Two timers per toast (visible, then fade) — tracked so a fast-firing
  // sequence of toasts never leaves an orphaned timer touching a toast that
  // was already removed.
  const timers = useRef(new Map<string, [number, number]>());

  useEffect(() => {
    return onToast((toast) => {
      setToasts((current) => [...current, { ...toast, leaving: false }]);

      const fadeTimer = window.setTimeout(() => {
        setToasts((current) =>
          current.map((entry) => (entry.id === toast.id ? { ...entry, leaving: true } : entry))
        );
        const removeTimer = window.setTimeout(() => {
          setToasts((current) => current.filter((entry) => entry.id !== toast.id));
          timers.current.delete(toast.id);
        }, FADE_MS);
        timers.current.set(toast.id, [fadeTimer, removeTimer]);
      }, VISIBLE_MS);
      timers.current.set(toast.id, [fadeTimer, -1]);
    });
  }, []);

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach(([a, b]) => {
        window.clearTimeout(a);
        if (b !== -1) window.clearTimeout(b);
      });
    };
  }, []);

  return createPortal(
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = ICON[toast.tone];
        return (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className={`toast ${CLASS_NAME[toast.tone]}${toast.leaving ? ' is-leaving' : ''}`}
          >
            <Icon size={15} className={`${CLASS_NAME[toast.tone]}__icon`} aria-hidden="true" />
            {toast.message}
          </div>
        );
      })}
    </div>,
    document.body
  );
}
