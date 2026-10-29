import { redirect } from "react-router";
import { paths } from "../lib/paths";
import type { Route } from "./+types/chat-redirect";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `/chat` → the draft; the Phase 2–6 `/chat?c=<id>` → `/chat/<id>`. */
export function loader({ request }: Route.LoaderArgs) {
  const id = new URL(request.url).searchParams.get("c");
  return redirect(id && UUID.test(id) ? paths.chat(id) : paths.newChat(), 301);
}
