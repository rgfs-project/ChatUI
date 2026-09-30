import { redirect } from "react-router";
import { appContext } from "../context";
import { paths } from "../lib/paths";
import type { Route } from "./+types/root-redirect";

/**
 * `/` (owner's decision, replacing the Phase 1a status page there): straight
 * into the app when signed in, to sign-in otherwise. The public status page
 * lives at `/status`. A loader-only route: no private markup is rendered.
 */
export function loader({ context }: Route.LoaderArgs) {
  const { auth } = context.get(appContext);
  return redirect(auth ? paths.newChat() : paths.login());
}
