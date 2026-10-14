import { useSearchParams } from "react-router";
import { ConversationView } from "../components/ConversationView";
import { useUserId } from "../lib/auth-store";
import type { Route } from "./+types/chat-new";

export function meta(): Route.MetaDescriptors {
  return [{ title: "New chat · ChatUI" }];
}

/** A draft: nothing is created until the first successful send. */
export default function ChatNew() {
  const [search] = useSearchParams();
  const projectId = search.get("project") ?? undefined;
  return (
    <ConversationView key={`new:${projectId ?? ""}`} userId={useUserId()} projectId={projectId} />
  );
}
