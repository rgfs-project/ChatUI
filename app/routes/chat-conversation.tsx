import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { data } from "react-router";
import { ChatView } from "../components/ChatView";
import { appContext } from "../context";
import { UUID } from "../lib/paths";
import { createQueryClient, isDehydratable, keys } from "../lib/query";
import type { Route } from "./+types/chat-conversation";

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `${loaderData.title ?? "Chat"} · ChatUI` }];
}

/**
 * The transcript for the first HTML. Ownership is enforced by the service:
 * another user's id is simply not found. Nothing is created or changed here.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { services, auth } = context.get(appContext);
  const id = params.conversationId;
  if (!auth)
    return data({ dehydratedState: undefined, title: null, missing: false }, { status: 401 });
  if (!UUID.test(id))
    return data({ dehydratedState: undefined, title: null, missing: true }, { status: 404 });
  const client = createQueryClient();
  let title: string | null = null;
  let status = 200;
  try {
    const dto = await services.conversationDto(auth.userId, id);
    title = dto.title;
    client.setQueryData(keys.conversation(auth.userId, id), dto);
  } catch (e) {
    status = (e as { code?: string }).code === "CONVERSATION_MALFORMED" ? 422 : 404;
  }
  const dehydratedState = dehydrate(client, {
    shouldDehydrateQuery: (q) => q.state.status === "success" && isDehydratable(q.queryKey),
  });
  client.clear();
  return data({ dehydratedState, title, missing: status !== 200 }, { status });
}

/** Client navigations read through the page's query cache instead. */
export function clientLoader() {
  return { dehydratedState: undefined, title: null, missing: false };
}

export default function ChatConversation({ loaderData, params }: Route.ComponentProps) {
  return (
    <HydrationBoundary state={loaderData.dehydratedState}>
      <ChatView
        key={params.conversationId}
        conversationId={params.conversationId}
        missing={loaderData.missing}
      />
    </HydrationBoundary>
  );
}
