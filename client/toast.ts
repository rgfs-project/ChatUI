/**
 * A tiny event bus for toasts, deliberately not React state or context.
 *
 * A toast is fired from deep inside a form — Settings, sign-in — that has no
 * reason to know the app shell exists, let alone hold a reference to it. A
 * module-level bus lets `showToast` be called from anywhere with no provider
 * to thread through and no re-render of everything between the caller and
 * `ToastHost`.
 */

import type { ReactNode } from 'react';

export type ToastTone = 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  tone: ToastTone;
  message: ReactNode;
}

type Listener = (toast: Toast) => void;

const listeners = new Set<Listener>();
let nextId = 0;

export function showToast(tone: ToastTone, message: ReactNode): void {
  nextId += 1;
  const toast: Toast = { id: `toast-${nextId}`, tone, message };
  listeners.forEach((listener) => listener(toast));
}

/** Subscribes to new toasts as they fire. Returns the unsubscribe function. */
export function onToast(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
