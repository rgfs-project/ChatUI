import { data, Link } from "react-router";
import { paths } from "../lib/paths";

export const handle = { kind: "page" };

/** An unmatched URL (signed in): a real 404 inside the shell. */
export function loader() {
  return data({ notFound: true }, { status: 404 });
}

export function clientLoader() {
  return { notFound: true };
}

export default function NotFound() {
  return (
    <div className="page-message" role="alert">
      <title>Page not found · ChatUI</title>
      <h1>Page not found</h1>
      <p>The page you requested does not exist.</p>
      <Link to={paths.newChat()} className="pill-button pill-primary">
        Start a new chat
      </Link>
    </div>
  );
}
