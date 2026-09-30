import { dehydrate, type DehydratedState } from "@tanstack/react-query";
import { createQueryClient, isDehydratable } from "./query";

/**
 * A fresh QueryClient per document/data request (INV-55): never module-global.
 * Only allowlisted, successful, browser-safe queries are dehydrated.
 */
export async function prefetchForRequest(
  seed: (client: ReturnType<typeof createQueryClient>) => Promise<void>,
): Promise<DehydratedState> {
  const client = createQueryClient();
  await seed(client);
  const state = dehydrate(client, {
    shouldDehydrateQuery: (query) =>
      query.state.status === "success" && isDehydratable(query.queryKey),
  });
  client.clear();
  return state;
}
