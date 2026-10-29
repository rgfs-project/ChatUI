import { redirect } from "react-router";
import { paths } from "../lib/paths";

/** Account management moved into Settings. */
export function loader() {
  return redirect(paths.settings("account"), 301);
}
