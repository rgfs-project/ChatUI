import { redirect } from "react-router";
import { appContext } from "../context";
import { paths } from "../lib/paths";
import type { Route } from "./+types/account";

/** The account page is a Settings section. */
export function loader({ context }: Route.LoaderArgs) {
  const { auth } = context.get(appContext);
  if (!auth) throw redirect(paths.login("/account"));
  throw redirect(paths.settings("account"));
}

export default function Account() {
  return null;
}
