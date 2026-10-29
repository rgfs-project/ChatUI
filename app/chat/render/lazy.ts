import { useEffect, useSyncExternalStore } from "react";

/**
 * Optional renderers load on demand, only when content needs them (contracts
 * §9.3), as separate first-party chunks. Until a module is ready (and always
 * during SSR and hydration) callers render a safe plain fallback.
 */
export interface LazyModule<T> {
  get: () => T | null;
  load: () => Promise<T>;
  subscribe: (listener: () => void) => () => void;
}

export function lazyModule<T>(importer: () => Promise<T>): LazyModule<T> {
  let value: T | null = null;
  let pending: Promise<T> | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    load: () => {
      pending ??= importer().then((loaded) => {
        value = loaded;
        for (const l of listeners) l();
        return loaded;
      });
      return pending;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The module once loaded (null on the server, while hydrating and until loaded). */
export function useLazy<T>(module: LazyModule<T>, wanted: boolean): T | null {
  const value = useSyncExternalStore(module.subscribe, module.get, () => null);
  useEffect(() => {
    if (wanted && !value) {
      module.load().catch(() => {
        // a failed chunk keeps the plain fallback (Phase 14: renderer stays functional)
      });
    }
  }, [module, value, wanted]);
  return value;
}
