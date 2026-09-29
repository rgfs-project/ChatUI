/**
 * Vite SSR build entry (build/server/index.js). Bundles the Express app factory
 * together with the React Router server build so both run in one process.
 */
import { createRequestHandler } from "@react-router/express";
import { RouterContextProvider } from "react-router";
import { appContext } from "../app/context.ts";
import type { AppOptions } from "./create-app.ts";

export { createApp } from "./create-app.ts";

export function createDocumentHandlerFactory(mode: string): AppOptions["createDocumentHandler"] {
  return (getValues) =>
    createRequestHandler({
      build: () => import("virtual:react-router/server-build"),
      mode,
      getLoadContext: (_req, res) => {
        const context = new RouterContextProvider();
        context.set(appContext, getValues(res));
        return context;
      },
    });
}
