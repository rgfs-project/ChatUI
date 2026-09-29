import { useEffect, type ReactNode } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  type LinksFunction,
} from "react-router";
import type { Route } from "./+types/root";
import stylesheet from "./app.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: stylesheet },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <Meta />
        {/* Stylesheets need no nonce (style-src 'self'). An explicit empty nonce keeps
            server and client markup identical: browsers hide nonce values from the
            DOM, so a server-only nonce would be a hydration mismatch. */}
        <Links nonce="" />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/** Marks the document once React has hydrated; used by `verify` and tests. */
function useHydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);
}

export default function App() {
  useHydrationMarker();
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  useHydrationMarker();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const title = notFound ? "Page not found" : "Something went wrong";
  const message = notFound
    ? "The page you requested does not exist."
    : "An unexpected error occurred. Please try again.";
  return (
    <main className="page">
      <title>{`${title} · ChatUI`}</title>
      <h1>{title}</h1>
      <p>{message}</p>
      <p>
        <a href="/">Return to the status page</a>
      </p>
    </main>
  );
}
