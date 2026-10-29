import { redirect } from "react-router";
import { appContext } from "../context";
import { paths } from "../lib/paths";
import type { Route } from "./+types/index";

/** `/` opens the chat when signed in, else sign-in. The status page is `/status`. */
export function loader({ context }: Route.LoaderArgs) {
  const { auth } = context.get(appContext);
  return redirect(auth ? paths.newChat() : paths.login());
}
