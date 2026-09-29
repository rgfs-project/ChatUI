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
    <main className="empty-state" role="main">
      <h1>Page not found</h1>
      <p>
        <Link to={paths.newChat()}>Start a new chat</Link>
      </p>
    </main>
  );
}
