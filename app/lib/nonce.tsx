import { createContext, useContext } from "react";

/**
 * The per-response CSP nonce, provided by entry.server only. Browsers hide
 * nonce values from the DOM, so the client renders an empty one; elements that
 * carry it suppress that single attribute mismatch.
 */
export const NonceContext = createContext("");

export function useNonce(): string {
  return useContext(NonceContext);
}
