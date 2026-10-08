import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { setNonce } from "get-nonce";
import { HydratedRouter } from "react-router/dom";

// Radix's scroll lock injects a <style>; give it this response's CSP nonce.
const scriptNonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
if (scriptNonce) setNonce(scriptNonce);

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
