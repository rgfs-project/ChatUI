import type { QueryClient } from "@tanstack/react-query";
import { makeQueryClient } from "./client";

/**
 * One QueryClient per document request, keyed by that request's router
 * context (created per request in server/app.ts). Nothing is module-global, so
 * no data can cross requests or users (INV-55).
 */
const clients = new WeakMap<object, QueryClient>();

export function requestQueryClient(requestContext: object): QueryClient {
  let client = clients.get(requestContext);
  if (!client) {
    client = makeQueryClient();
    clients.set(requestContext, client);
  }
  return client;
}
