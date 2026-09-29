import { createContext } from "react-router";
import type { DocumentRequestValues } from "../server/create-app.ts";

/**
 * Per-request values supplied by Express to document loaders and
 * entry.server (INV-55: created per request in server/app.ts, never global).
 */
export const appContext = createContext<DocumentRequestValues>();
