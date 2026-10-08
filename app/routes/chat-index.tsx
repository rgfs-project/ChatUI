import { redirect } from "react-router";
import { paths } from "../lib/paths";
import type { Route } from "./+types/chat-index";

/** `/chat` (and the legacy `/chat?c=<id>`) open a chat. */
export function loader({ request }: Route.LoaderArgs) {
  const legacy = new URL(request.url).searchParams.get("c");
  throw redirect(legacy ? paths.chat(legacy) : paths.newChat());
}

export default function ChatIndex() {
  return null;
}
