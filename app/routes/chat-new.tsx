import { useRouteLoaderData } from "react-router";
import { ConversationView } from "../components/ConversationView";
import type { loader as layoutLoader } from "./app-layout";
import type { Route } from "./+types/chat-new";

export function meta(): Route.MetaDescriptors {
  return [{ title: "New chat · ChatUI" }];
}

/** A draft: nothing is created until the first successful send. */
export default function ChatNew() {
  const layout = useRouteLoaderData<typeof layoutLoader>("routes/app-layout");
  return <ConversationView key="new" userId={layout?.user.id ?? ""} />;
}
