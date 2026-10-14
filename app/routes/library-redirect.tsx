import { Navigate } from "react-router";
import { paths } from "../lib/paths";
import type { Route } from "./+types/library-redirect";

/** `/library` became `/projects`. */
export default function LibraryRedirect({ params }: Route.ComponentProps) {
  return <Navigate to={paths.projects(params.projectId)} replace />;
}
