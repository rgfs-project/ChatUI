import { ChatView } from "../components/ChatView";
import type { Route } from "./+types/chat-new";

export function meta(): Route.MetaDescriptors {
  return [{ title: "New chat · ChatUI" }];
}

export default function ChatNew() {
  return <ChatView key="new" />;
}
