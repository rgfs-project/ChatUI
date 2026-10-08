import { data, redirect } from "react-router";
import { appContext } from "../context";
import { paths } from "../lib/paths";
import type { Route } from "./+types/admin";

/** Administration now lives in Settings; non-admins see nothing here. */
export function loader({ context }: Route.LoaderArgs) {
  const { auth } = context.get(appContext);
  if (auth?.role !== "admin") throw data("Not found", { status: 404 });
  throw redirect(paths.settings("users"));
}

export default function Admin() {
  return null;
}
