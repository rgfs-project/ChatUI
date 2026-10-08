import { createContext } from "react-router";
import type { DocumentRequestValues } from "../server/create-app.ts";

/** Per-request values Express hands to loaders and entry.server (never global). */
export const appContext = createContext<DocumentRequestValues>();
