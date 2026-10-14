import { data, Link } from "react-router";
import { paths } from "../lib/paths";

/** Unmatched URLs inside the guarded shell: a route error, never a create. */
export function loader() {
  throw data("Not found", { status: 404 });
}

export default function NotFound() {
  return null;
}

export function ErrorBoundary() {
  return (
    <main className="empty-state">
      <h1>Page not found</h1>
      <p>There’s nothing at this address.</p>
      <Link to={paths.newChat()} className="btn primary">
        Start a new chat
      </Link>
    </main>
  );
}
