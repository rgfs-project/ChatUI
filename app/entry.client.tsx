import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

// Modal dialogs insert one <style> element for scroll locking; it carries this
// document's CSP nonce (read from a framework script; the attribute is hidden).
(globalThis as { __webpack_nonce__?: string }).__webpack_nonce__ =
  document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce ?? "";

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
