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
import { appContext } from "./context";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState as useClientState } from "react";
import { setSession } from "./lib/api";
import { createQueryClient } from "./lib/query";
import { useAccountBoundary } from "./lib/use-account-boundary";
import stylesheet from "./app.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: stylesheet },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

/** Browser-safe session bootstrap, rendered into private no-store HTML (§5). */
export function loader({ context }: Route.LoaderArgs) {
  const { services, auth } = context.get(appContext);
  return { session: services.auth.sessionDto(auth) };
}

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

export default function App({ loaderData }: Route.ComponentProps) {
  useHydrationMarker();
  // One browser QueryClient per page load (the server uses one per request).
  const [queryClient] = useClientState(createQueryClient);
  // Client-only: the shared fetch wrapper learns the session after hydration.
  useEffect(() => {
    setSession(loaderData.session);
  }, [loaderData.session]);
  // Account boundary: a changed account purges the previous user's cache.
  useAccountBoundary(queryClient, loaderData.session.user?.id ?? null);
  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  );
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
