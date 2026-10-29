import type { QueryClient } from "@tanstack/react-query";
import type { SessionDto } from "@shared/auth";
import { currentSession, setSession } from "./api";
import { isUserScoped, qk } from "./query/keys";

/** Cancels and removes every user-scoped query (account switch, sign-out, expiry). */
export function purgeUserCache(client: QueryClient): void {
  const predicate = (query: { queryKey: readonly unknown[] }) => isUserScoped(query.queryKey);
  void client.cancelQueries({ predicate });
  client.removeQueries({ predicate });
}

/**
 * Applies a session observed from the server: the fetch adapter's identity and
 * the session query move together, and a different account purges the cache.
 */
export function applySession(client: QueryClient, session: SessionDto): void {
  const previous = client.getQueryData<SessionDto>(qk.session()) ?? currentSession();
  if (previous && previous.user?.id !== session.user?.id) purgeUserCache(client);
  setSession(session);
  client.setQueryData(qk.session(), session);
}
