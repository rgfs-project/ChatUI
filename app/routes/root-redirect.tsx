import { redirect } from "react-router";
import { appContext } from "../context";
import { paths } from "../lib/paths";
import type { Route } from "./+types/root-redirect";

/** `/`: into the app when signed in, to sign-in otherwise. */
export function loader({ context }: Route.LoaderArgs) {
  const { auth } = context.get(appContext);
  return redirect(auth ? paths.newChat() : paths.login());
}
