import { HydrationBoundary } from "@tanstack/react-query";
import { data } from "react-router";
import { ConversationView } from "../components/ConversationView";
import { appContext } from "../context";
import { authStore, useUserId } from "../lib/auth-store";
import { claimIntent } from "../lib/prefetch";
import { ApiError, getQueryClient, queries, queryKeys } from "../lib/query";
import { prefetchForRequest } from "../lib/server-query";
import type { Route } from "./+types/chat-conversation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `${loaderData.title ?? "Conversation"} · ChatUI` }];
}

/**
 * Authorized transcript for SSR (INV-54): ownership is enforced by the
 * service (another user's id is not-found). A missing id is a data error in
 * an existing route: it never creates or mutates anything.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { services, auth } = context.get(appContext);
  const id = params.conversationId;
  // Client navigations do not re-run the layout guard: an expired session is
  // reported as data, and the view opens the re-authentication dialog.
  if (!auth)
    return data(
      { dehydratedState: undefined, error: { status: 401, code: "UNAUTHENTICATED" }, title: null },
      { status: 401 },
    );
  if (!UUID.test(id))
    return data(
      { dehydratedState: undefined, error: { status: 404, code: "NOT_FOUND" }, title: null },
      { status: 404 },
    );
  const result: { title: string | null; error: { status: number; code: string } | null } = {
    title: null,
    error: null,
  };
  const dehydratedState = await prefetchForRequest(async (client) => {
    try {
      const dto = await services.conversationDto(auth.userId, id);
      result.title = dto.title;
      client.setQueryData(queryKeys.conversation(auth.userId, id), dto);
    } catch (e) {
      const code = (e as { code?: string }).code;
      result.error =
        code === "CONVERSATION_MALFORMED"
          ? { status: 422, code }
          : { status: 404, code: "NOT_FOUND" };
    }
  });
  // Missing or malformed data keeps the shell but carries its HTTP status.
  return data(
    { dehydratedState, error: result.error, title: result.title },
    { status: result.error?.status ?? 200 },
  );
}

type LoadError = { status: number; code: string } | null;

/**
 * Client navigations read through the page's QueryClient instead of a server
 * data request: the same `queries.conversation` options the view consumes and
 * an intent prefetch warms (INV-31), so a hovered-then-clicked conversation
 * reuses the cached or in-flight request. Cached data renders at once (the
 * view refetches it if stale); only a cold conversation is awaited.
 */
export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const id = params.conversationId;
  const auth = authStore.get();
  const userId = auth.status === "authenticated" ? auth.session?.user?.id : undefined;
  const result = (error: LoadError, title: string | null = null) => ({
    dehydratedState: undefined,
    error,
    title,
  });
  if (!userId) return result({ status: 401, code: "UNAUTHENTICATED" });
  if (!UUID.test(id)) return result({ status: 404, code: "NOT_FOUND" });
  claimIntent(id);
  const client = getQueryClient();
  const options = queries.conversation(userId, id);
  const cached = client.getQueryData(options.queryKey);
  if (cached) return result(null, cached.title);
  try {
    const dto = await client.query(options);
    return result(null, dto.title);
  } catch (error) {
    // Data errors render in the route; anything else is retried by the view.
    if (error instanceof ApiError && [401, 404, 422].includes(error.status))
      return result({ status: error.status, code: error.code ?? "NOT_FOUND" });
    return result(null);
  }
}

export default function ChatConversation({ loaderData, params }: Route.ComponentProps) {
  const userId = useUserId();
  return (
    <HydrationBoundary state={loaderData.dehydratedState}>
      <ConversationView
        key={params.conversationId}
        userId={userId}
        conversationId={params.conversationId}
        initialError={loaderData.error}
      />
    </HydrationBoundary>
  );
}
